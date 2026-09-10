import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';
import {
  evaluateReadiness, shouldDeliver, DEFAULT_DELIVERY, DEFAULT_POLICY,
  type DeliveryWindow, type Observation, type ReadinessPolicy,
} from '@fantacomics/ingest';
import type { LlmDriver } from '@fantacomics/llm';
import { runMatchdayPipeline } from './pipeline.js';
import type { LeagueConfig, LeagueStore } from './store.js';

/**
 * IL TICK DI CONSEGNA.
 *
 * Qui si incontrano le due domande che il progetto tiene separate fin
 * dall'inizio: il cron decide QUANDO CHIEDERE, la macchina a stati decide
 * QUANDO È PRONTO. Finora esistevano entrambe ma non si parlavano, e
 * "consegna automatica" era una frase senza codice sotto.
 *
 * È un TICK, non un ciclo: una passata e ritorna. È ciò che lo rende
 * eseguibile da un cron, da una coda durabile o da un test senza cambiare una
 * riga — un ciclo con `sleep` dentro sarebbe stato collaudabile solo
 * aspettando davvero.
 */

/**
 * Da dove arrivano i dati.
 *
 * Il tick non sa nulla di piattaforme: chiede a questa interfaccia. È lo
 * stesso motivo per cui esiste l'Anti-Corruption Layer — oggi dietro c'è
 * l'estensione, domani un adapter diverso, e il pianificatore non se ne
 * accorge.
 */
export type FonteGiornata = {
  /**
   * Le osservazioni della giornata GLOBALE di Serie A, dalla più vecchia alla
   * più recente. Una per giornata, non una per lega: è la scelta che riduce le
   * richieste di ordini di grandezza.
   */
  osservazioni(matchday: number): Promise<readonly Observation[]>;
  /**
   * Il materiale della lega per quella giornata, quando c'è. `null` significa
   * "questa lega non ha ancora i suoi dati" — non è un errore: una lega può
   * non aver ancora schierato o non essere collegata.
   */
  materiale(
    config: LeagueConfig,
    matchday: number,
  ): Promise<{ serieA: SerieAMatchday; snapshot: LeagueWeekSnapshot } | null>;
};

export type AzioneLega =
  | 'pubblicata'
  | 'in-revisione'
  | 'attesa-dati'
  | 'attesa-giornata'
  | 'attesa-finestra'
  | 'errore';

export type EsitoLega = {
  leagueId: string;
  leagueName: string;
  matchday: number;
  azione: AzioneLega;
  motivo: string;
  confidenza?: number;
};

export type TickInput = {
  store: LeagueStore;
  fonte: FonteGiornata;
  /** Le leghe da considerare in questo tick. */
  leghe: readonly LeagueConfig[];
  now?: Date;
  window?: DeliveryWindow;
  policy?: ReadinessPolicy;
  driver?: LlmDriver;
  fallback?: LlmDriver;
};

export type TickOutput = {
  esiti: EsitoLega[];
  /** Quante volte è stata interrogata la giornata globale: deve essere una per giornata. */
  lettureGlobali: number;
  durataMs: number;
};

/** La prossima giornata da produrre per una lega. */
export function prossimaGiornata(config: LeagueConfig): number {
  return (config.lastMatchday ?? 0) + 1;
}

export async function tickConsegne(input: TickInput): Promise<TickOutput> {
  const inizio = Date.now();
  const now = input.now ?? new Date();
  const esiti: EsitoLega[] = [];

  /**
   * La giornata globale si legge UNA VOLTA per giornata, non una per lega.
   * Non è un'ottimizzazione: è la tesi architetturale del progetto. Con
   * cinquecento leghe sulla stessa giornata, chiederla per lega significa
   * cinquecento richieste identiche e un ban meritato.
   */
  const cache = new Map<number, readonly Observation[]>();
  let lettureGlobali = 0;
  const osservazioniDi = async (matchday: number): Promise<readonly Observation[]> => {
    const gia = cache.get(matchday);
    if (gia) return gia;
    lettureGlobali++;
    const lette = await input.fonte.osservazioni(matchday);
    cache.set(matchday, lette);
    return lette;
  };

  for (const config of input.leghe) {
    const matchday = prossimaGiornata(config);
    const base = { leagueId: config.leagueId, leagueName: config.leagueName, matchday };

    try {
      // Idempotenza: se l'edizione c'è già, il tick non la rifà. Un cron che
      // ripubblica a ogni passata è peggio di un cron che non parte.
      if (await input.store.getEdition(config.leagueId, matchday)) {
        esiti.push({ ...base, azione: 'pubblicata', motivo: 'Edizione già presente: niente da fare.' });
        continue;
      }

      const decisione = evaluateReadiness(
        await osservazioniDi(matchday),
        input.policy ?? DEFAULT_POLICY,
      );
      if (!decisione.ready) {
        esiti.push({ ...base, azione: 'attesa-giornata', motivo: decisione.reason });
        continue;
      }

      const consegna = shouldDeliver(decisione, now, input.window ?? DEFAULT_DELIVERY);
      if (!consegna.deliver) {
        esiti.push({ ...base, azione: 'attesa-finestra', motivo: consegna.reason });
        continue;
      }

      const materiale = await input.fonte.materiale(config, matchday);
      if (!materiale) {
        esiti.push({
          ...base, azione: 'attesa-dati',
          motivo: 'Giornata pronta ma i dati della lega non sono ancora arrivati.',
        });
        continue;
      }

      const esito = await runMatchdayPipeline({
        snapshot: materiale.snapshot,
        serieA: materiale.serieA,
        rules: config.ruleset,
        store: input.store,
        spice: config.spice,
        ...(input.driver ? { driver: input.driver } : {}),
        ...(input.fallback ? { fallback: input.fallback } : {}),
      });

      esiti.push({
        ...base,
        azione: esito.publishable ? 'pubblicata' : 'in-revisione',
        motivo: esito.publishable
          ? `Pubblicata: ${esito.edition.articles.length} pezzi.`
          : `Confidenza ${esito.edition.meta.confidence}: va in revisione invece che online.`,
        confidenza: esito.edition.meta.confidence,
      });
    } catch (e) {
      /**
       * Il guasto di una lega non ferma le altre.
       *
       * Con un solo `throw` non catturato, una lega con dati malformati
       * impedirebbe il giornale a tutte quelle dopo di lei nell'elenco — e
       * l'ordine dell'elenco non è una proprietà che qualcuno abbia scelto.
       */
      esiti.push({
        ...base, azione: 'errore',
        motivo: e instanceof Error ? e.message : 'Errore sconosciuto.',
      });
    }
  }

  return { esiti, lettureGlobali, durataMs: Date.now() - inizio };
}

/** Righe leggibili per il log di un cron. */
export function riassumiTick(out: TickOutput): string {
  const per = (a: AzioneLega): number => out.esiti.filter((e) => e.azione === a).length;
  return [
    `${out.esiti.length} leghe in ${out.durataMs}ms, ${out.lettureGlobali} letture della giornata globale`,
    `pubblicate ${per('pubblicata')}, in revisione ${per('in-revisione')}, errori ${per('errore')}`,
    `in attesa: ${per('attesa-giornata')} giornata, ${per('attesa-finestra')} finestra, ${per('attesa-dati')} dati`,
  ].join(' · ');
}
