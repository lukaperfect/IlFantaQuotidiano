import { z } from 'zod';
import { AdapterError } from '../adapter.js';
import {
  FieldMappingSchema, applyMapping, mappingCoverage, type RelayEnvelope,
} from './extension-relay.js';
import { importFromRecords, type Righe } from './file-import.js';
import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';
import { stableHash } from '@fantacomics/core';

/**
 * DAI PAYLOAD DELL'ESTENSIONE ALLO SNAPSHOT CANONICO.
 *
 * Il punto di questo file e' che NON contiene conoscenza della piattaforma.
 * Quale risposta guardare e come si chiamano i campi dentro sta in un profilo,
 * che e' dato: si aggiorna lato server e l'estensione lo riceve alla prossima
 * apertura, senza ripubblicarla e senza aspettare che gli utenti aggiornino.
 *
 * E' la ragione per cui perdere la piattaforma non e' un rifacimento: cambiare
 * profilo e' una riga di configurazione, non un rilascio.
 */

export const CaptureRuleSchema = z.object({
  /** Il nome canonico del payload: voti, formazioni, calendario, rose, classifica. */
  id: z.string().min(1),
  /**
   * Sottostringa dell'URL da osservare. Deliberatamente NON una regex: questa
   * stringa arriva dal server e viene applicata dentro il browser dell'utente,
   * quindi deve restare inerte anche se la si scrivesse male.
   */
  urlContains: z.string().min(1),
});
export type CaptureRule = z.infer<typeof CaptureRuleSchema>;

export const PlatformProfileSchema = z.object({
  platform: z.string().min(1),
  version: z.number().int().min(1),
  /** Su quali domini l'estensione ha titolo di guardare. */
  hosts: z.array(z.string().min(1)).min(1),
  capture: z.array(CaptureRuleSchema).min(1),
  /** id del payload -> mappatura dei campi. */
  mappings: z.record(z.string(), FieldMappingSchema),
});
export type PlatformProfile = z.infer<typeof PlatformProfileSchema>;

/** I payload senza i quali non si costruisce niente. */
export const PAYLOAD_OBBLIGATORI = ['voti', 'formazioni', 'calendario'] as const;

/**
 * Da valore JSON a cella.
 *
 * I costruttori condivisi leggono celle di testo, ed e' un vantaggio, non un
 * compromesso: la distinzione fra "assente" e "zero" — un giocatore SV contro
 * uno che ha preso zero — sopravvive solo se l'assenza resta una cella vuota
 * invece di diventare un numero.
 */
function cella(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value;
  return '';
}

export type CoperturaPayload = {
  id: string;
  record: number;
  ratio: number;
  campiMancanti: Record<string, number>;
};

/**
 * Applica il profilo ai payload grezzi.
 *
 * Non lancia sui payload facoltativi mancanti: una lega senza rose e senza
 * classifica produce un giornale piu' povero, non un errore.
 */
export function recordsFromEnvelope(
  envelope: RelayEnvelope,
  profile: PlatformProfile,
): { righe: Record<string, Righe>; copertura: CoperturaPayload[] } {
  const righe: Record<string, Righe> = {};
  const copertura: CoperturaPayload[] = [];

  for (const [id, mapping] of Object.entries(profile.mappings)) {
    const payload = envelope.payloads[id];
    if (payload === undefined) {
      if ((PAYLOAD_OBBLIGATORI as readonly string[]).includes(id)) {
        throw new AdapterError(
          `Manca il payload "${id}", che serve per costruire la giornata. ` +
          'L’estensione non ha visto passare quella risposta: probabile pagina non aperta.',
          'parse', true,
        );
      }
      continue;
    }

    const estratti = applyMapping(payload, mapping);
    righe[id] = estratti.map((r) => {
      const riga: Record<string, string> = {};
      for (const [campo, valore] of Object.entries(r)) riga[campo] = cella(valore);
      return riga;
    });

    const richiesti = Object.keys(mapping.fields);
    const { ratio, missing } = mappingCoverage(estratti, richiesti);
    copertura.push({ id, record: estratti.length, ratio, campiMancanti: missing });
  }

  for (const id of PAYLOAD_OBBLIGATORI) {
    if (!righe[id]) {
      throw new AdapterError(
        `Il profilo "${profile.platform}" v${profile.version} non mappa "${id}".`,
        'parse', false,
      );
    }
  }

  return { righe, copertura };
}

export type RelayImportMeta = {
  leagueId: string;
  leagueName: string;
  season: string;
};

/** Il giro completo: envelope + profilo -> snapshot canonico. */
export function importFromRelay(
  envelope: RelayEnvelope,
  profile: PlatformProfile,
  meta: RelayImportMeta,
): { serieA: SerieAMatchday; snapshot: LeagueWeekSnapshot; copertura: CoperturaPayload[] } {
  const { righe, copertura } = recordsFromEnvelope(envelope, profile);

  const { serieA, snapshot } = importFromRecords({
    season: meta.season,
    matchday: envelope.matchday,
    leagueId: meta.leagueId,
    leagueName: meta.leagueName,
    collector: 'browser-extension',
    // L'hash sta sui payload grezzi, non sui record estratti: cosi' cambia
    // anche quando cambia solo la mappatura, ed e' cio' che serve per
    // accorgersi che la stessa giornata e' stata riletta diversamente.
    contentHash: stableHash(JSON.stringify(envelope.payloads)),
    voti: righe.voti ?? [],
    formazioni: righe.formazioni ?? [],
    calendario: righe.calendario ?? [],
    ...(righe.rose ? { rose: righe.rose } : {}),
    ...(righe.classifica ? { classifica: righe.classifica } : {}),
    ...(righe.partiteSerieA ? { partiteSerieA: righe.partiteSerieA } : {}),
    collectedAt: envelope.capturedAt,
  });

  return { serieA, snapshot, copertura };
}

/** La copertura peggiore fra i payload: e' quella che decide se pubblicare. */
export function coperturaMinima(copertura: readonly CoperturaPayload[]): number {
  if (copertura.length === 0) return 0;
  return Math.min(...copertura.map((c) => c.ratio));
}

/**
 * La stagione in corso da una data.
 *
 * La Serie A scavalca l'anno solare: da agosto a maggio. Dedurla dall'anno
 * corrente e basta produce "2026-27" a gennaio 2026, cioe' una stagione che
 * deve ancora cominciare — e un archivio storico che si spezza a Capodanno.
 */
export function stagioneDi(date: Date): string {
  const anno = date.getUTCFullYear();
  const inizio = date.getUTCMonth() >= 6 ? anno : anno - 1;
  return `${inizio}-${String((inizio + 1) % 100).padStart(2, '0')}`;
}
