import type { FactPack, NarrativeFact } from '@fantacomics/core';
import { fmt, safeName } from '@fantacomics/core';
import type { LeagueMatchdayResult } from '@fantacomics/scoring';
import { buildContext, toFact, type FactContext, type HistoricalMatchday, type LeagueHistory, type RarityCorpus } from './context.js';
import { buildTeamViews, type TeamView } from './views.js';
import { detectLuck } from './detectors/luck.js';
import { detectThresholds } from './detectors/thresholds.js';
import { detectRegret } from './detectors/regret.js';
import { detectManagement } from './detectors/management.js';
import { detectPlayers } from './detectors/players.js';
import { detectModifiers } from './detectors/modifiers.js';
import { detectHistory } from './detectors/history.js';

/** Versionata: ogni edizione salva quale motore l'ha prodotta. */
export const FACT_ENGINE_VERSION = '1.0.0';

export type FactEngineOutput = {
  facts: NarrativeFact[];
  views: Map<string, TeamView>;
  /** Da persistere: alimenta l'indice di ingiustizia cumulato delle giornate future. */
  luckDeltas: Record<string, number>;
  context: FactContext;
};

export type FactEngineOptions = {
  history?: LeagueHistory;
  corpus?: RarityCorpus | null;
};

/**
 * Funzione PURA: (result, storico, corpus) -> fatti.
 * Nessun I/O, nessuna data corrente, nessun random non seedato.
 * È ciò che la rende testabile con golden file e riproducibile a distanza di mesi.
 */
export function generateFacts(
  result: LeagueMatchdayResult,
  opts: FactEngineOptions = {},
): FactEngineOutput {
  const ctx = buildContext(result, opts);
  const views = buildTeamViews(ctx);
  const matchday = result.snapshot.matchday;

  const drafts = [
    ...detectLuck(ctx, views),
    ...detectThresholds(ctx, views),
    ...detectRegret(ctx, views),
    ...detectManagement(ctx, views),
    ...detectPlayers(ctx, views),
    ...detectModifiers(ctx, views),
    ...detectHistory(ctx, views),
  ];

  const byId = new Map<string, NarrativeFact>();
  for (const draft of drafts) {
    const fact = toFact(matchday, draft);
    const existing = byId.get(fact.id);
    // A parità di id vince il drama più alto: due detector possono vedere lo stesso evento.
    if (!existing || fact.drama > existing.drama) byId.set(fact.id, fact);
  }

  const facts = [...byId.values()].sort((a, b) => b.drama - a.drama || a.id.localeCompare(b.id));

  const luckDeltas: Record<string, number> = {};
  for (const [teamId, v] of views) luckDeltas[teamId] = v.luckDelta;

  return { facts, views, luckDeltas, context: ctx };
}

/** Il pacchetto che viaggia verso l'LLM: fatti + tabellino, niente altro. */
export function buildFactPack(
  result: LeagueMatchdayResult,
  output: FactEngineOutput,
): FactPack {
  const ctx = output.context;

  const results = result.fixtures.map((f) => ({
    homeTeam: ctx.teamName(f.homeTeamId),
    awayTeam: ctx.teamName(f.awayTeamId),
    homePoints: fmt(f.homeScore.total, 1),
    awayPoints: fmt(f.awayScore.total, 1),
    homeGoals: String(f.homeGoals),
    awayGoals: String(f.awayGoals),
  }));

  const before = new Map(result.snapshot.standingsBefore.map((r) => [r.teamId, r]));
  const rows = [...output.views.values()].map((v) => {
    const prev = before.get(v.teamId);
    return {
      teamId: v.teamId,
      points: (prev?.points ?? 0) + v.actualLeaguePoints,
      fantasy: (prev?.totalFantasyPoints ?? 0) + v.points,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.fantasy - a.fantasy);

  return {
    leagueId: result.snapshot.leagueId,
    leagueName: safeName(result.snapshot.leagueName, 60),
    matchday: result.snapshot.matchday,
    season: result.snapshot.season,
    factEngineVersion: FACT_ENGINE_VERSION,
    facts: output.facts,
    results,
    standings: rows.map((r, i) => ({
      position: `${i + 1}°`,
      teamName: ctx.teamName(r.teamId),
      points: String(r.points),
    })),
  };
}

/**
 * Riassunto della giornata da persistere.
 * È ciò che rende possibili record, filotti, maledizioni e indice di
 * ingiustizia cumulato: senza memoria, 38 output isolati; con memoria, una
 * narrazione stagionale — che è la cosa che si rinnova l'anno dopo.
 */
export function buildHistoryEntry(
  result: LeagueMatchdayResult,
  output: FactEngineOutput,
): HistoricalMatchday {
  const points: Record<string, number> = {};
  const results: Record<string, 'W' | 'D' | 'L'> = {};
  const opponents: Record<string, string> = {};
  const positions: Record<string, number> = {};

  for (const [teamId, v] of output.views) {
    points[teamId] = v.points;
    results[teamId] = v.outcome;
    opponents[teamId] = v.opponentId;
  }

  const before = new Map(result.snapshot.standingsBefore.map((r) => [r.teamId, r]));
  const rows = [...output.views.values()].map((v) => {
    const prev = before.get(v.teamId);
    return {
      teamId: v.teamId,
      points: (prev?.points ?? 0) + v.actualLeaguePoints,
      fantasy: (prev?.totalFantasyPoints ?? 0) + v.points,
    };
  }).sort((a, b) => b.points - a.points || b.fantasy - a.fantasy);
  rows.forEach((r, i) => { positions[r.teamId] = i + 1; });

  return {
    matchday: result.snapshot.matchday,
    points, results, opponents, positions,
    luckDelta: output.luckDeltas,
  };
}
