import type { FactPack, NarrativeFact } from '@fantacomics/core';

/**
 * GROUNDING NUMERICO.
 *
 * Ogni cifra prodotta dal modello viene estratta e verificata contro
 * l'insieme dei numeri che gli sono stati effettivamente passati.
 * Elimina strutturalmente la classe di errore piu' letale del prodotto:
 * un numero sbagliato nel gruppo WhatsApp non e' un bug, e' la fine.
 */

export type NumberHit = {
  raw: string;
  normalized: string;
  context: string;
  index: number;
};

export type Violation = NumberHit & {
  /**
   * `high`  = ha la forma di una statistica (decimale, grande, o seguita da
   *           un'unita' come "punti"): va bloccata.
   * `low`   = intero piccolo e nudo, quasi sempre un conteggio in prosa
   *           ("i 3 difensori"): si segnala, non si blocca.
   */
  severity: 'high' | 'low';
};

export type GroundingReport = {
  ok: boolean;
  checked: number;
  violations: Violation[];
};

const NUMBER_RE = /(?<![\w.,])([+-]?\d{1,4}(?:[.,]\d{1,2})?)\s*(°|%|ª)?/g;
const STAT_UNITS = /^\s*(punt|gol|fantavot|vot|xg|volt|posizion|giornat|euro|milion|%)/i;

/** Porta un numero a forma canonica: "71,5" -> "71.5", "72.0" -> "72", "+3" -> "3". */
export function normalizeNumber(raw: string): string {
  let s = raw.trim().replace(',', '.').replace(/[+]/g, '');
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s === '' ? '0' : s;
}

export function extractNumbers(text: string): NumberHit[] {
  const hits: NumberHit[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const index = m.index ?? 0;
    hits.push({
      raw,
      normalized: normalizeNumber(raw),
      context: text.slice(Math.max(0, index - 28), index + raw.length + 28).replace(/\s+/g, ' '),
      index,
    });
  }
  return hits;
}

function addValue(set: Set<string>, value: string): void {
  /**
   * Si estraggono i numeri invece di spezzare la stringa: un risultato come
   * "1-2" deve autorizzare "1" e "2" presi singolarmente, e con uno split che
   * tratta il trattino come parte del numero non succede.
   */
  for (const m of value.matchAll(/-?\d+(?:[.,]\d+)?/g)) {
    const n = normalizeNumber(m[0]);
    if (n && /\d/.test(n)) {
      set.add(n);
      // Anche la parte intera: "71.5" autorizza "71" in una frase arrotondata.
      if (n.includes('.')) set.add(n.split('.')[0] as string);
    }
  }
}

/** L'insieme dei numeri che il modello ha il diritto di scrivere. */
export function allowedNumbersFor(
  facts: readonly NarrativeFact[],
  extra: readonly string[] = [],
): Set<string> {
  const allowed = new Set<string>();
  for (const fact of facts) {
    for (const value of Object.values(fact.numbers)) addValue(allowed, value);
    // Anche i numeri contenuti nella frase secca: sono gli stessi, gia' in prosa.
    for (const hit of extractNumbers(fact.plain)) allowed.add(hit.normalized);
    allowed.add(String(fact.matchday));
  }
  for (const e of extra) addValue(allowed, e);
  return allowed;
}

/** Estende l'insieme con tabellino e classifica del pack. */
export function allowedNumbersForPack(pack: FactPack, facts?: readonly NarrativeFact[]): Set<string> {
  const allowed = allowedNumbersFor(facts ?? pack.facts, [String(pack.matchday), pack.season]);
  for (const r of pack.results) {
    for (const v of [r.homePoints, r.awayPoints, r.homeGoals, r.awayGoals]) addValue(allowed, v);
  }
  for (const s of pack.standings) {
    addValue(allowed, s.position);
    addValue(allowed, s.points);
  }
  return allowed;
}

function severityOf(hit: NumberHit, text: string): 'high' | 'low' {
  if (hit.normalized.includes('.')) return 'high';
  const value = Number(hit.normalized);
  if (Number.isFinite(value) && value >= 12) return 'high';
  const after = text.slice(hit.index + hit.raw.length, hit.index + hit.raw.length + 14);
  return STAT_UNITS.test(after) ? 'high' : 'low';
}

/**
 * Verifica un testo. `ok` e' falso solo per violazioni `high`: bloccare anche
 * gli interi piccoli in prosa scarterebbe pezzi legittimi ("i 3 difensori")
 * senza guadagnare sicurezza reale.
 */
export function checkGrounding(text: string, allowed: ReadonlySet<string>): GroundingReport {
  const hits = extractNumbers(text);
  const violations: Violation[] = [];
  for (const hit of hits) {
    if (allowed.has(hit.normalized)) continue;
    violations.push({ ...hit, severity: severityOf(hit, text) });
  }
  return {
    ok: violations.every((v) => v.severity !== 'high'),
    checked: hits.length,
    violations,
  };
}

/** Raccoglie tutto il testo scrivibile da un blocco IR, per la verifica. */
export function textOfBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { parts.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // `kind` e `factId` sono metadati, non prosa: non vanno verificati.
        if (key === 'kind' || key === 'factId') continue;
        walk(value);
      }
    }
  };
  walk(blocks);
  return parts.join('\n');
}
