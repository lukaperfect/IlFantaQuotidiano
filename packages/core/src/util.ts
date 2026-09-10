/** Formattazione: unica fonte di verità su come un numero appare nel giornale. */
export function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals).replace(/\.0$/, decimals === 1 ? '' : '');
}

/** Numero con segno esplicito: "+3.5" / "-0.5". Serve ai delta. */
export function fmtSigned(n: number, decimals = 1): string {
  const s = Math.abs(n).toFixed(decimals);
  return `${n < 0 ? '-' : '+'}${s}`;
}

export function fmtOrdinal(n: number): string {
  return `${n}°`;
}

/** Arrotonda a 2 decimali eliminando il rumore in virgola mobile. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** PRNG deterministico (mulberry32): stessa lega + stessa giornata => stesso giornale. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash stabile e corto: id di fatti, contentHash, cache key. */
export function stableHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
