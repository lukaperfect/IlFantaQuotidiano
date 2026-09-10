import { DEFAULT_RULESET } from '@fantacomics/core';
import { generateWorld, withOfficialScores, exportAll } from '@fantacomics/ingest';

/**
 * I MODELLI DEI CSV.
 *
 * Il percorso da file e' l'interruttore di emergenza del prodotto: se domani
 * la piattaforma chiude gli accessi, il sistema continua in modalita' manuale
 * invece di spegnersi. Ma un interruttore che non sai azionare non e' un
 * interruttore, e il modulo chiedeva cinque file senza dire una parola su
 * quali colonne servissero: l'unico modo di scoprirlo era leggere il codice.
 *
 * I modelli NON sono scritti a mano. Escono dallo stesso esportatore che un
 * test di round-trip lega all'importatore, quindi non possono divergere da
 * cio' che l'importatore accetta davvero: il giorno in cui una colonna cambia,
 * cambia anche il modello, senza che nessuno debba ricordarsene.
 */

export const NOMI_MODELLI = ['voti', 'formazioni', 'calendario', 'rose', 'classifica'] as const;
export type NomeModello = (typeof NOMI_MODELLI)[number];

export function modelli(): Record<NomeModello, string> {
  // Dati finti e deterministici: nessun segreto, quindi si possono anche
  // scaricare prima di avere un account — che e' esattamente quando servono.
  const mondo = withOfficialScores(
    generateWorld({ seed: 'modello-csv', teams: 8, matchday: 1 }),
    DEFAULT_RULESET,
  );
  const csv = exportAll(mondo.serieA, mondo.snapshot);
  return {
    voti: csv.votiCsv,
    formazioni: csv.formazioniCsv,
    calendario: csv.calendarioCsv,
    rose: csv.roseCsv,
    classifica: csv.classificaCsv,
  };
}

/** Le sole intestazioni, per mostrarle in pagina senza far scaricare niente. */
export function intestazioni(): Record<NomeModello, string> {
  const tutti = modelli();
  return Object.fromEntries(
    NOMI_MODELLI.map((n) => [n, tutti[n].split('\n')[0] ?? '']),
  ) as Record<NomeModello, string>;
}
