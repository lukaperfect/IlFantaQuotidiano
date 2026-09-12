import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';
import {
  evaluateReadiness, shouldDeliver, DEFAULT_DELIVERY, DEFAULT_POLICY,
  decidiUscita, USCITE_PREDEFINITE,
  type CalendarioGiornata, type DeliveryWindow, type Observation, type OpzioniUscite,
  type ReadinessPolicy,
} from '@fantacomics/ingest';
import type { LlmDriver } from '@fantacomics/llm';
import { runMatchdayPipeline, runAnteprimaPipeline } from './pipeline.js';
import type { SfidaInProgramma } from '@fantacomics/facts';
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
   * Cio' che gia' sappiamo della giornata, SENZA chiedere niente a nessuno.
   *
   * Esiste per una ragione sola, e non e' l'eleganza: un tier gratuito ha un
   * tetto. Misurato su un fine settimana vero di Serie A, un cron ogni dieci
   * minuti che interroga il servizio a ogni passata costa 144 richieste al
   * giorno; rispettando l'attesa che la macchina a stati gia' calcola ne costa
   * 27, e la giornata risulta pronta sei minuti dopo. Con un tetto di cento al
   * giorno la differenza e' fra funzionare e non funzionare.
   *
   * Facoltativa: una fonte che non sa rispondere lascia che le si chieda
   * sempre, cioe' il comportamento di prima.
   */
  storiche?(matchday: number): Promise<readonly Observation[]>;
  /**
   * Il materiale della lega per quella giornata, quando c'è. `null` significa
   * "questa lega non ha ancora i suoi dati" — non è un errore: una lega può
   * non aver ancora schierato o non essere collegata.
   */
  materiale(
    config: LeagueConfig,
    matchday: number,
  ): Promise<{ serieA: SerieAMatchday; snapshot: LeagueWeekSnapshot } | null>;
  /**
   * GLI ORARI DI SERIE A DELLA GIORNATA. Piano globale: sono gli stessi per
   * tutte le leghe, quindi si leggono una volta sola come i voti.
   *
   * Facoltativa. Una fonte che non li sa lascia decidere alla macchina a stati
   * sui dati, che e' il comportamento di prima: un orario mancante e'
   * un'informazione che non abbiamo, non un divieto.
   */
  calendario?(matchday: number): Promise<CalendarioGiornata | null>;
  /**
   * Gli ACCOPPIAMENTI della lega per quella giornata, senza il resto.
   *
   * Esiste separata da `materiale` perche' la vigilia ha bisogno solo di
   * questi: chiedere il pacchetto completo significherebbe scaricare voti e
   * formazioni di una giornata non ancora giocata, cioe' pagare quattro
   * richieste per lega per ottenere righe vuote.
   */
  sfide?(config: LeagueConfig, matchday: number): Promise<readonly SfidaInProgramma[]>;
};

export type AzioneLega =
  | 'pubblicata'
  | 'vigilia-pubblicata'
  | 'non-pagata'
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
  /**
   * La stagione in corso. Decide QUALE diritto a pubblicare si controlla: il
   * pagamento e' per lega e per stagione, e una lega pagata l'anno scorso non
   * e' pagata quest'anno.
   *
   * Esplicita e non dedotta dall'orologio qui dentro: e' la condizione che
   * separa chi riceve il giornale da chi no, e una funzione che se la calcola
   * da sola non si puo' provare su una stagione diversa da oggi.
   */
  season: string;
  now?: Date;
  window?: DeliveryWindow;
  /** Quando escono i due numeri: fuso e ora della mattina. */
  uscite?: OpzioniUscite;
  policy?: ReadinessPolicy;
  driver?: LlmDriver;
  fallback?: LlmDriver;
  /**
   * Salta l'attesa fra una richiesta e l'altra e interroga comunque la fonte.
   *
   * Serve a un operatore: «il fornitore aveva un guasto, adesso ricontrolla»
   * senza aspettare l'ora che la macchina a stati aveva chiesto. NON salta
   * nessun controllo di correttezza — la giornata resta soggetta agli stessi
   * cancelli — salta solo una cortesia verso il servizio e il proprio tetto di
   * richieste.
   */
  ignoraAttesa?: boolean;
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
  /** Anche le storiche si leggono una volta per giornata, non una per lega. */
  const cacheStoriche = new Map<number, readonly Observation[]>();
  const storicheDi = async (matchday: number): Promise<readonly Observation[]> => {
    const gia = cacheStoriche.get(matchday);
    if (gia) return gia;
    const lette = (await input.fonte.storiche?.(matchday)) ?? [];
    cacheStoriche.set(matchday, lette);
    return lette;
  };

  /**
   * Anche il calendario e' piano globale: una lettura per giornata, non per
   * lega. E' la stessa tesi che vale per i voti, applicata al terzo dato che
   * tutte le leghe condividono.
   */
  const cacheCalendario = new Map<number, CalendarioGiornata | null>();
  const calendarioDi = async (matchday: number): Promise<CalendarioGiornata | null> => {
    if (cacheCalendario.has(matchday)) return cacheCalendario.get(matchday) ?? null;
    const letto = (await input.fonte.calendario?.(matchday)) ?? null;
    cacheCalendario.set(matchday, letto);
    return letto;
  };

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

      /**
       * SENZA PAGAMENTO NON SI PUBBLICA, e il controllo sta PRIMA di tutto il
       * resto.
       *
       * Non e' pignoleria sull'ordine: dopo questo punto si interroga un
       * servizio a consumo e si fa girare un modello a pagamento. Un cancello
       * messo alla fine avrebbe lasciato che una lega non pagata costasse
       * esattamente quanto una pagata, con l'unica differenza che il giornale
       * non si vede. Il costo va speso solo per chi ha pagato.
       */
      const diritto = await input.store.getEntitlement(config.leagueId, input.season);
      if (!diritto) {
        esiti.push({
          ...base, azione: 'non-pagata',
          motivo: `Lega non attiva per la stagione ${input.season}: nessun giornale.`,
        });
        continue;
      }

      /**
       * QUALE DEI DUE NUMERI TOCCA, secondo il calendario vero.
       *
       * La premessa «ogni martedi'» era sbagliata e sopravviveva qui dentro
       * come finestra di consegna: la Serie A gioca il venerdi' sera, il
       * lunedi' sera, ha turni infrasettimanali e rinvii. Una giornata puo'
       * cominciare venerdi' e finire lunedi', o stare tutta in un mercoledi'.
       *
       * Senza calendario si ricade sul comportamento precedente — decide la
       * macchina a stati, con la vecchia finestra — invece di bloccare tutto:
       * un fornitore che smette di pubblicare gli orari non deve poter
       * spegnere il prodotto in silenzio.
       */
      const calendario = await calendarioDi(matchday);
      const uscite = input.uscite ?? USCITE_PREDEFINITE;
      const quando = calendario
        ? decidiUscita(calendario, now, uscite)
        : { uscita: 'retrospettivo' as const, motivo: 'Nessun calendario: decide la macchina a stati.', fraSecondi: 0 };

      if (quando.uscita === 'nessuna') {
        esiti.push({ ...base, azione: 'attesa-finestra', motivo: quando.motivo });
        continue;
      }

      if (quando.uscita === 'vigilia') {
        esiti.push(await tentaVigilia(input, config, matchday, base));
        continue;
      }

      /**
       * PRIMA DI CHIEDERE, SI GUARDA COSA SI SA GIA'.
       *
       * `recheckAfterSeconds` esisteva da sempre: la macchina a stati lo
       * calcolava in quattro punti, il relay lo riportava nella risposta, un
       * test lo asseriva. E poi NESSUNO lo guardava — il pianificatore
       * interrogava la fonte a ogni passata comunque. E' la stessa famiglia di
       * difetto della soglia di revisione: un valore calcolato dappertutto e
       * applicato da nessuna parte, invisibile finche' non arriva il primo
       * fornitore con un tetto.
       */
      const gia = await storicheDi(matchday);
      let decisione = gia.length > 0
        ? evaluateReadiness(gia, input.policy ?? DEFAULT_POLICY)
        : null;

      if (decisione !== null && !decisione.ready) {
        const ultima = Date.parse(gia[gia.length - 1]!.fetchedAt);
        const prossima = ultima + decisione.recheckAfterSeconds * 1000;
        if (!input.ignoraAttesa && Number.isFinite(ultima) && now.getTime() < prossima) {
          const fra = Math.ceil((prossima - now.getTime()) / 60000);
          esiti.push({
            ...base, azione: 'attesa-giornata',
            motivo: `${decisione.reason} Troppo presto per richiedere: riprovo fra ${fra} minuti.`,
          });
          continue;
        }
      }

      // Qui si paga la richiesta: o non sappiamo niente, o l'attesa e' scaduta.
      if (decisione === null || !decisione.ready || input.ignoraAttesa) {
        decisione = evaluateReadiness(
          await osservazioniDi(matchday),
          input.policy ?? DEFAULT_POLICY,
        );
      }

      if (!decisione.ready) {
        esiti.push({ ...base, azione: 'attesa-giornata', motivo: decisione.reason });
        continue;
      }

      /**
       * La vecchia finestra vale SOLO quando non c'e' un calendario.
       *
       * Con il calendario la decisione l'ha gia' presa `decidiUscita`, che sa
       * quando e' finita davvero la giornata; applicare anche il martedi' fisso
       * rimetterebbe dentro proprio la premessa che si sta togliendo, e un
       * turno infrasettimanale finito il giovedi' aspetterebbe cinque giorni.
       */
      if (calendario === null) {
        const consegna = shouldDeliver(decisione, now, input.window ?? DEFAULT_DELIVERY);
        if (!consegna.deliver) {
          esiti.push({ ...base, azione: 'attesa-finestra', motivo: consegna.reason });
          continue;
        }
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

/**
 * IL NUMERO DI VIGILIA, dentro il tick.
 *
 * Sta in una funzione a parte perche' non condivide NIENTE con il percorso del
 * retrospettivo: non ci sono osservazioni da valutare, non c'e' una macchina a
 * stati da interrogare e non c'e' niente da riconciliare. L'unica cosa che le
 * serve e' la rosa, che l'admin ha caricato una volta a inizio stagione.
 */
async function tentaVigilia(
  input: TickInput,
  config: LeagueConfig,
  matchday: number,
  base: { leagueId: string; leagueName: string; matchday: number },
): Promise<EsitoLega> {
  // Idempotenza, sul SUO indirizzo: la vigilia e il retrospettivo della stessa
  // giornata sono due edizioni, e la presenza di una non dice niente dell'altra.
  if (await input.store.getEdition(config.leagueId, matchday, 'anteprima')) {
    return { ...base, azione: 'pubblicata', motivo: 'Vigilia gia\' pubblicata: niente da fare.' };
  }

  const roster = await input.store.getRoster(config.leagueId);
  if (!roster) {
    return {
      ...base, azione: 'attesa-dati',
      motivo: 'Nessuna rosa caricata: la vigilia non ha materia di cui parlare.',
    };
  }

  /**
   * Gli accoppiamenti sono un di piu', non un requisito: alla prima giornata
   * di una lega nuova il calendario di lega puo' non essere ancora arrivato, e
   * l'asta da sola basta a fare un giornale. Se la fonte non sa rispondere si
   * procede senza, invece di saltare il primo numero di un cliente che ha
   * appena pagato.
   */
  let sfide: readonly SfidaInProgramma[] = [];
  try {
    sfide = (await input.fonte.sfide?.(config, matchday)) ?? [];
  } catch {
    sfide = [];
  }

  const esito = await runAnteprimaPipeline({
    leagueId: config.leagueId,
    leagueName: config.leagueName,
    roster,
    matchday,
    fixtures: sfide,
    store: input.store,
    rulesetVersion: config.ruleset.version,
    spice: config.spice,
    ...(input.driver ? { driver: input.driver } : {}),
    ...(input.fallback ? { fallback: input.fallback } : {}),
  });

  return {
    ...base,
    azione: esito.publishable ? 'vigilia-pubblicata' : 'in-revisione',
    motivo: esito.publishable
      ? `Vigilia pubblicata: ${esito.edition.articles.length} pezzi, ${sfide.length} sfide in programma.`
      : `Confidenza ${esito.edition.meta.confidence}: la vigilia va in revisione.`,
    confidenza: esito.edition.meta.confidence,
  };
}

/** Righe leggibili per il log di un cron. */
export function riassumiTick(out: TickOutput): string {
  const per = (a: AzioneLega): number => out.esiti.filter((e) => e.azione === a).length;
  return [
    `${out.esiti.length} leghe in ${out.durataMs}ms, ${out.lettureGlobali} letture della giornata globale`,
    `pubblicate ${per('pubblicata')} (di cui ${per('vigilia-pubblicata')} vigilie), `
    + `in revisione ${per('in-revisione')}, errori ${per('errore')}`,
    `in attesa: ${per('attesa-giornata')} giornata, ${per('attesa-finestra')} finestra, `
    + `${per('attesa-dati')} dati, ${per('non-pagata')} non attive`,
  ].join(' · ');
}
