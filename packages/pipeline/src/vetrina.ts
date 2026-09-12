/**
 * IL TETTO ALLE LEGHE DI VETRINA.
 *
 * La lega di prova non passa dal cancello del pagamento, ed e' una scelta:
 * chiedere 4,99 euro a chi non ha ancora visto il prodotto e' il modo piu'
 * sicuro di perderlo. I dati sono sintetici, quindi non e' il prodotto
 * regalato — e' la vetrina.
 *
 * Il costo pero' e' reale: tre edizioni di otto pezzi ciascuna, con una chiave
 * vera. Senza un tetto, quell'azione si ripete all'infinito, e chi paga il
 * conto non e' chi la ripete.
 *
 * STA QUI E NON DENTRO L'AZIONE perche' una regola sepolta in una server
 * action non si puo' provare senza un browser, e una regola che protegge una
 * spesa deve avere un test che cade quando la si toglie.
 */

import type { LeagueConfig } from './store.js';

/**
 * Due, e si sceglie sapendo cosa si sta comprando: una per guardare il
 * prodotto, una per riprovare con impostazioni diverse — il numero di squadre
 * o il tono cambiano il giornale abbastanza da voler rivedere. La terza non
 * aggiunge niente che le prime due non abbiano gia' mostrato.
 */
export const MAX_LEGHE_DI_PROVA = 2;

export function tettoLegheDiProva(
  env: Record<string, string | undefined> = process.env,
): number {
  const scritto = env.FANTACOMICS_MAX_LEGHE_PROVA?.trim();
  /**
   * Vuota vale come assente, e non come zero.
   *
   * `Number('')` fa zero, quindi la lettura ingenua spegnerebbe la vetrina
   * ogni volta che un file di deploy dichiara la variabile senza valorizzarla
   * — che capita, e non e' mai cio' che si intendeva.
   */
  if (scritto === undefined || scritto === '') return MAX_LEGHE_DI_PROVA;
  const n = Number(scritto);
  // Un valore illeggibile non spalanca il cancello: si torna al predefinito.
  // Zero invece e' una scelta legittima — spegne la vetrina — e va rispettata.
  return Number.isInteger(n) && n >= 0 ? n : MAX_LEGHE_DI_PROVA;
}

export type EsitoVetrina =
  | { puo: true }
  | { puo: false; motivo: string };

export function puoCreareLegaDiProva(
  leghe: readonly LeagueConfig[],
  tetto: number = MAX_LEGHE_DI_PROVA,
): EsitoVetrina {
  /**
   * Si contano le leghe con `origine: 'prova'`, non quelle il cui
   * identificatore comincia per `prova-`. Il prefisso e' una convenzione, e un
   * tetto che si regge su una convenzione si disattiva al primo rinominare
   * senza che niente lo segnali.
   *
   * Le leghe senza origine — scritte prima che il campo esistesse — contano
   * come dell'utente: non aprono uno slot, ma nemmeno ne occupano uno.
   */
  const quante = leghe.filter((l) => l.origine === 'prova').length;
  if (quante < tetto) return { puo: true };

  return {
    puo: false,
    motivo: tetto === 0
      ? 'Le leghe di prova sono disattivate: carica il file delle rose della tua lega.'
      : `Hai gia' ${quante} ${quante === 1 ? 'lega' : 'leghe'} di prova su ${tetto}. `
        + 'Per una lega vera carica il file delle rose: il giornale esce dai tuoi dati.',
  };
}
