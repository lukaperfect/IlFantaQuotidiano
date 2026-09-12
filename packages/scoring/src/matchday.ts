import type { LeagueRuleset, LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';
import { indexStats, type StatIndex } from './fantavote.js';
import { computeTeamScore, type TeamScore } from './score.js';
import { computeRegret, type RegretBreakdown } from './optimal.js';
import { reconcile, type ReconciliationReport } from './reconcile.js';

export type FixtureResult = {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: TeamScore;
  awayScore: TeamScore;
  homeGoals: number;
  awayGoals: number;
  outcome: 'home' | 'away' | 'draw';
  /** Distanza in punti tra i due: la materia della "beffa decimale". */
  pointsMargin: number;
};

export type LeagueMatchdayResult = {
  snapshot: LeagueWeekSnapshot;
  rules: LeagueRuleset;
  stats: StatIndex;
  scores: Map<string, TeamScore>;
  regrets: Map<string, RegretBreakdown>;
  fixtures: FixtureResult[];
  reconciliation: ReconciliationReport;
  /** Se true le metriche controfattuali non sono attendibili e vanno taciute. */
  degraded: boolean;
};

/** Esegue l'intero calcolo di una giornata di lega. Pura: nessun I/O. */
export function computeLeagueMatchday(
  snapshot: LeagueWeekSnapshot,
  serieA: SerieAMatchday,
  rules: LeagueRuleset,
): LeagueMatchdayResult {
  const stats = indexStats(serieA.players);
  const lineupByTeam = new Map(snapshot.lineups.map((l) => [l.teamId, l]));
  const homeTeamIds = new Set(snapshot.fixtures.map((f) => f.homeTeamId));

  const scores = new Map<string, TeamScore>();
  for (const lineup of snapshot.lineups) {
    scores.set(
      lineup.teamId,
      computeTeamScore(lineup, stats, rules, { isHome: homeTeamIds.has(lineup.teamId) }),
    );
  }

  const reconciliation = reconcile(snapshot, scores);
  const degraded = !reconciliation.ok;

  const regrets = new Map<string, RegretBreakdown>();
  if (!degraded) {
    for (const team of snapshot.teams) {
      const lineup = lineupByTeam.get(team.teamId);
      const score = scores.get(team.teamId);
      if (!lineup || !score) continue;
      const selected = [...lineup.starters, ...lineup.bench].map((s) => s.playerId);
      const roster = team.roster.length > 0 ? team.roster.map((r) => r.playerId) : selected;
      regrets.set(
        team.teamId,
        computeRegret(score, selected, roster, stats, rules, {
          isHome: homeTeamIds.has(team.teamId),
        }),
      );
    }
  }

  const fixtures: FixtureResult[] = [];
  for (const f of snapshot.fixtures) {
    const homeScore = scores.get(f.homeTeamId);
    const awayScore = scores.get(f.awayTeamId);
    if (!homeScore || !awayScore) continue;
    const outcome =
      homeScore.goals > awayScore.goals ? 'home' : awayScore.goals > homeScore.goals ? 'away' : 'draw';
    fixtures.push({
      homeTeamId: f.homeTeamId,
      awayTeamId: f.awayTeamId,
      homeScore,
      awayScore,
      homeGoals: homeScore.goals,
      awayGoals: awayScore.goals,
      outcome,
      pointsMargin: Math.abs(Math.round((homeScore.total - awayScore.total) * 100) / 100),
    });
  }

  return { snapshot, rules, stats, scores, regrets, fixtures, reconciliation, degraded };
}
