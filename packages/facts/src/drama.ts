import type { RarityCorpus } from './context.js';

/**
 * Il drama score non è gusto: è rarità.
 *
 *   drama = peso_del_tipo * (0.55 + 0.45 * intensita)   [0..100]
 *         + bonus_rarita                                 [0..+18]
 *
 * `intensita` normalizza la magnitudine DENTRO il tipo (un rimpianto da 30
 * punti non è un rimpianto da 6), il bonus premia gli estremi della
 * distribuzione. Tenere la formula esplicita e in un solo posto è ciò che
 * permette di calibrarla senza toccare 40 detector.
 */
export function drama(
  typeWeight: number,
  opts: { intensity?: number; rarityPercentile?: number | null } = {},
): number {
  const intensity = clamp01(opts.intensity ?? 0.5);
  let value = typeWeight * (0.55 + 0.45 * intensity);

  const p = opts.rarityPercentile;
  if (p !== null && p !== undefined) {
    const extremity = Math.max(0, Math.max(p - 90, 10 - p)) / 10; // 0..1
    value += 18 * clamp01(extremity);
  }
  return Math.max(0, Math.min(100, value));
}

/** Normalizza un valore in 0..1 rispetto a una scala attesa. */
export function intensityOf(value: number, softMax: number): number {
  if (softMax <= 0) return 0;
  return clamp01(Math.abs(value) / softMax);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Percentile di un valore nella distribuzione cross-lega (ricerca binaria). */
export function percentileOf(corpus: RarityCorpus | null, value: number): number | null {
  if (!corpus || corpus.sortedTeamPoints.length < 30) return null;
  const arr = corpus.sortedTeamPoints;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === undefined || v < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / arr.length) * 1000) / 10;
}
