import { z } from 'zod';
import { AdapterError } from '../adapter.js';

/**
 * IL COLLECTOR PRIMARIO CONSIGLIATO.
 *
 * Un'estensione che gira nella sessione dell'admin intercetta le risposte JSON
 * che la pagina già scarica e le rilancia qui. Tre vantaggi che nessun
 * scraping lato server può eguagliare:
 *
 * 1. zero credenziali custodite — non si conserva la password di una
 *    piattaforma terza, che nel 90% dei casi è riusata altrove;
 * 2. zero rischio di ban — il traffico è quello dell'utente, con il suo IP e
 *    volumi umani: non è accesso automatizzato, è leggere dati che l'utente
 *    ha già davanti;
 * 3. i payload JSON interni cambiano molto più lentamente del DOM: un
 *    restyling completo del frontend spesso non tocca gli endpoint.
 *
 * Il mapping dei campi è DATO, non codice: si aggiorna lato server senza
 * ripubblicare l'estensione e attendere che gli utenti aggiornino.
 */

export const FieldMappingSchema = z.object({
  version: z.number().int().min(1),
  /** Percorso alla collezione dentro il payload grezzo, es. "data.rosters". */
  root: z.string().min(1),
  /** campo canonico -> percorso relativo all'elemento, es. { vote: "stats.v" } */
  fields: z.record(z.string(), z.string()),
});
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const RelayEnvelopeSchema = z.object({
  /** Versione dell'estensione: serve a diagnosticare i client vecchi. */
  clientVersion: z.string().min(1),
  platform: z.string().min(1),
  leagueExternalId: z.string().min(1),
  matchday: z.number().int().min(1).max(38),
  /** Facoltativa: se manca la decide il server, che sa in che giorno vive. */
  season: z.string().min(4).max(16).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  /** I payload grezzi, così come la pagina li ha ricevuti. */
  payloads: z.record(z.string(), z.unknown()),
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

/** Risolve "a.b[0].c" dentro un oggetto sconosciuto, senza mai lanciare. */
export function resolvePath(source: unknown, path: string): unknown {
  if (path === '' || path === '$') return source;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s !== '' && s !== '$');

  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Applica una mappatura a un payload grezzo, producendo record canonici. */
export function applyMapping(payload: unknown, mapping: FieldMapping): Record<string, unknown>[] {
  const root = resolvePath(payload, mapping.root);
  if (!Array.isArray(root)) {
    throw new AdapterError(
      `Il percorso "${mapping.root}" non contiene un elenco (mapping v${mapping.version}). ` +
      'Probabile deriva della piattaforma: verificare il canary.',
      'parse', false,
    );
  }
  return root.map((item) => {
    const record: Record<string, unknown> = {};
    for (const [field, path] of Object.entries(mapping.fields)) {
      record[field] = resolvePath(item, path);
    }
    return record;
  });
}

/**
 * Verifica l'integrità dell'envelope prima di toccarne il contenuto.
 * Tutto ciò che arriva da un client è ostile finché non è validato.
 */
export function parseEnvelope(raw: unknown): RelayEnvelope {
  const result = RelayEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AdapterError(`Envelope del relay non valido: ${detail}`, 'parse', false);
  }
  return result.data;
}

/** Quanti record una mappatura riesce effettivamente a estrarre: il segnale del canary. */
export function mappingCoverage(
  records: readonly Record<string, unknown>[],
  requiredFields: readonly string[],
): { ratio: number; missing: Record<string, number> } {
  const missing: Record<string, number> = {};
  if (records.length === 0) return { ratio: 0, missing };

  let complete = 0;
  for (const record of records) {
    let ok = true;
    for (const field of requiredFields) {
      if (record[field] === undefined) {
        missing[field] = (missing[field] ?? 0) + 1;
        ok = false;
      }
    }
    if (ok) complete++;
  }
  return { ratio: complete / records.length, missing };
}
