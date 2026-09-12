import type { NarrativeFact, FactType, EntityRef, Polarity, PlayerMatchStat } from '@fantacomics/core';
import { safeName, stableHash } from '@fantacomics/core';
import type { LeagueMatchdayResult } from '@fantacomics/scoring';

/** Riassunto di una giornata passata: alimenta record, filotti e rimonte. */
export type HistoricalMatchday = {
  matchday: number;
  /** teamId -> punti fantacalcio realizzati. */
  points: Record<string, number>;
  /** teamId -> 'W' | 'D' | 'L'. */
  results: Record<string, 'W' | 'D' | 'L'>;
  /** teamId -> id dell'avversario di quella giornata. */
  opponents: Record<string, string>;
  /** teamId -> posizione in classifica dopo quella giornata. */
  positions: Record<string, number>;
  /** teamId -> delta di fortuna cumulato in quella giornata. */
  luckDelta?: Record<string, number>;
};

export type LeagueHistory = {
  /** Ordinate per giornata crescente, ESCLUSA quella corrente. */
  entries: HistoricalMatchday[];
};

/**
 * Distribuzione cross-lega dei punteggi di squadra della stagione.
 * È il vantaggio competitivo che cresce con gli utenti: "il quarto punteggio
 * più basso mai registrato" è credibile solo se il dato esiste davvero.
 */
export type RarityCorpus = {
  /** Punteggi osservati, ORDINATI in modo crescente. */
  sortedTeamPoints: readonly number[];
};

export type FactContext = {
  result: LeagueMatchdayResult;
  history: LeagueHistory;
  corpus: RarityCorpus | null;
  teamName: (teamId: string) => string;
  managerName: (teamId: string) => string;
  playerName: (playerId: string) => string;
  stat: (playerId: string) => PlayerMatchStat | undefined;
};

export function teamRef(ctx: FactContext, teamId: string): EntityRef {
  return { kind: 'team', id: teamId, display: ctx.teamName(teamId) };
}

export function playerRef(ctx: FactContext, playerId: string): EntityRef {
  return { kind: 'player', id: playerId, display: safeName(ctx.playerName(playerId), 32) };
}

/** Costruisce il contesto, sanitizzando ogni nome che proviene dall'utente. */
export function buildContext(
  result: LeagueMatchdayResult,
  opts: { history?: LeagueHistory; corpus?: RarityCorpus | null } = {},
): FactContext {
  const teams = new Map(result.snapshot.teams.map((t) => [t.teamId, t]));
  const ctx: FactContext = {
    result,
    history: opts.history ?? { entries: [] },
    corpus: opts.corpus ?? null,
    teamName: (id) => safeName(teams.get(id)?.teamName ?? id),
    managerName: (id) => safeName(teams.get(id)?.managerName ?? id, 32),
    playerName: (id) => result.stats.get(id)?.playerName ?? id,
    stat: (id) => result.stats.get(id),
  };
  return ctx;
}

export type FactDraft = {
  type: FactType;
  subjects: EntityRef[];
  numbers: Record<string, string>;
  polarity: Polarity;
  drama: number;
  plain: string;
  rarityPercentile?: number | null;
  evidence?: { source: string; detail?: string }[];
};

/**
 * Id deterministico: stessa giornata e stessi soggetti => stesso id.
 * È il perno di dedup, cooldown e memoria anti-ripetizione.
 */
export function factId(type: FactType, matchday: number, subjects: readonly EntityRef[]): string {
  const key = `${type}|${matchday}|${subjects.map((s) => `${s.kind}:${s.id}`).sort().join(',')}`;
  return `${type.toLowerCase()}-${stableHash(key)}`;
}

export function toFact(matchday: number, draft: FactDraft): NarrativeFact {
  return {
    id: factId(draft.type, matchday, draft.subjects),
    type: draft.type,
    matchday,
    subjects: draft.subjects,
    numbers: draft.numbers,
    polarity: draft.polarity,
    drama: Math.max(0, Math.min(100, Math.round(draft.drama))),
    rarityPercentile: draft.rarityPercentile ?? null,
    plain: draft.plain,
    evidence: (draft.evidence ?? []).map((e) => ({ source: e.source, detail: e.detail ?? '' })),
  };
}
