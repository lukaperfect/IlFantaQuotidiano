import type { Usage } from './driver.js';

/** Prezzi per milione di token (Claude API, listino di riferimento). */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Le letture da cache costano ~0.1x l'input base. È la leva che regge il modello di costo. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Scrittura in cache: 1.25x con TTL 5m, 2x con TTL 1h. */
export const CACHE_WRITE_MULTIPLIER_1H = 2;
/** Il Batch dimezza tutto. I voti sono definitivi la notte, il giornale serve la mattina. */
export const BATCH_DISCOUNT = 0.5;

export type CostBreakdown = {
  inputUSD: number;
  cacheReadUSD: number;
  cacheWriteUSD: number;
  outputUSD: number;
  totalUSD: number;
};

export function costOf(usage: Usage, opts: { batch?: boolean } = {}): CostBreakdown {
  const price = PRICING[usage.model];
  if (!price) {
    return { inputUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, outputUSD: 0, totalUSD: 0 };
  }
  const discount = opts.batch ? BATCH_DISCOUNT : 1;
  const perToken = price.input / 1_000_000;

  const inputUSD = usage.inputTokens * perToken * discount;
  const cacheReadUSD = usage.cacheReadTokens * perToken * CACHE_READ_MULTIPLIER * discount;
  const cacheWriteUSD = usage.cacheWriteTokens * perToken * CACHE_WRITE_MULTIPLIER_1H * discount;
  const outputUSD = usage.outputTokens * (price.output / 1_000_000) * discount;

  const totalUSD = inputUSD + cacheReadUSD + cacheWriteUSD + outputUSD;
  return {
    inputUSD: round6(inputUSD),
    cacheReadUSD: round6(cacheReadUSD),
    cacheWriteUSD: round6(cacheWriteUSD),
    outputUSD: round6(outputUSD),
    totalUSD: round6(totalUSD),
  };
}

export function totalCost(usages: readonly (Usage | null)[], opts: { batch?: boolean } = {}): CostBreakdown {
  const acc: CostBreakdown = { inputUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, outputUSD: 0, totalUSD: 0 };
  for (const u of usages) {
    if (!u) continue;
    const c = costOf(u, opts);
    acc.inputUSD += c.inputUSD;
    acc.cacheReadUSD += c.cacheReadUSD;
    acc.cacheWriteUSD += c.cacheWriteUSD;
    acc.outputUSD += c.outputUSD;
    acc.totalUSD += c.totalUSD;
  }
  return {
    inputUSD: round6(acc.inputUSD), cacheReadUSD: round6(acc.cacheReadUSD),
    cacheWriteUSD: round6(acc.cacheWriteUSD), outputUSD: round6(acc.outputUSD),
    totalUSD: round6(acc.totalUSD),
  };
}

/**
 * Proiezione a stagione. Serve per una decisione architetturale, non per la
 * contabilità: se l'LLM è il 2-3% del ricavo, l'ingegneria va messa altrove.
 */
export function seasonProjection(perEditionUSD: number, leagues: number, matchdays = 38): {
  perEditionUSD: number; perLeagueSeasonUSD: number; totalSeasonUSD: number;
} {
  return {
    perEditionUSD: round6(perEditionUSD),
    perLeagueSeasonUSD: round6(perEditionUSD * matchdays),
    totalSeasonUSD: round6(perEditionUSD * matchdays * leagues),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
