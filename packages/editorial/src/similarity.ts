/**
 * GUARDIA ANTI-RIPETIZIONE SUL TESTO.
 *
 * Il cooldown su tipi di fatto e format impedisce di raccontare le stesse
 * cose; non impedisce di raccontarle con le stesse parole. Due pezzi con
 * format diversi possono suonare identici, ed e' cosi' che un giornale
 * settimanale smette di essere letto.
 *
 * La misura giusta qui e' il CONTENIMENTO, non la similarita' simmetrica di
 * Jaccard: interessa quanta parte del pezzo NUOVO ricalca il passato. Un
 * pezzo corto che ricopia integralmente una frase di un'edizione lunga ha
 * Jaccard basso e contenimento alto — ed e' il caso che vogliamo cogliere.
 */

/** Normalizza per il confronto: minuscole, niente punteggiatura, spazi singoli. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Insieme degli n-grammi di parole. n=5 coglie le frasi ricalcate, non le collocazioni comuni. */
export function shingles(text: string, n = 5): Set<string> {
  const words = normalizeForComparison(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i <= words.length - n; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Quota degli n-grammi del testo nuovo già presenti nel corpus passato.
 * 0 = niente in comune, 1 = interamente ricalcato.
 */
export function containment(nuovo: ReadonlySet<string>, passato: ReadonlySet<string>): number {
  if (nuovo.size === 0) return 0;
  let comuni = 0;
  for (const s of nuovo) if (passato.has(s)) comuni++;
  return comuni / nuovo.size;
}

/** Oltre questa quota il pezzo si considera ricalcato e va riscritto. */
export const SOGLIA_RIPETIZIONE = 0.25;

export type RepetitionReport = {
  ripetuto: boolean;
  /** 0-1: quanta parte del pezzo nuovo esisteva già. */
  containment: number;
  /** Le frasi ricalcate, per dirlo al modello nella correzione. */
  frasiRipetute: string[];
};

export function checkRepetition(
  testoNuovo: string,
  corpusPassato: ReadonlySet<string>,
  soglia = SOGLIA_RIPETIZIONE,
): RepetitionReport {
  const nuovo = shingles(testoNuovo);
  const c = containment(nuovo, corpusPassato);
  const frasiRipetute: string[] = [];
  for (const s of nuovo) {
    if (corpusPassato.has(s) && frasiRipetute.length < 5) frasiRipetute.push(s);
  }
  return { ripetuto: c > soglia, containment: Math.round(c * 1000) / 1000, frasiRipetute };
}

/** Costruisce il corpus degli n-grammi già usati dalle edizioni recenti. */
export function buildPastCorpus(testiPassati: readonly string[], n = 5): Set<string> {
  const corpus = new Set<string>();
  for (const t of testiPassati) for (const s of shingles(t, n)) corpus.add(s);
  return corpus;
}
