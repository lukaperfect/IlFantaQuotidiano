import { round2 } from '@fantacomics/core';
import type { RegretBreakdown, TeamScore } from '@fantacomics/scoring';
import type { FactContext } from './context.js';

/**
 * Vista per squadra, calcolata una volta e condivisa da tutti i detector.
 * Contiene il GIRONE VIRTUALE: la singola metrica che genera da sola metà
 * del materiale comico, perché trasforma "sono sfortunato" in un numero.
 */
export type TeamView = {
  teamId: string;
  score: TeamScore;
  points: number;
  goals: number;
  opponentId: string;
  opponentPoints: number;
  opponentGoals: number;
  isHome: boolean;
  outcome: 'W' | 'D' | 'L';
  pointsMargin: number;
  /** Posizione per punteggio nella giornata: 1 = miglior punteggio. */
  rank: number;
  /** Quanti avversari avrebbe battuto giocando contro tutti. */
  virtualWins: number;
  virtualDraws: number;
  virtualLosses: number;
  /** Punti di classifica attesi dal girone virtuale (media su tutti gli avversari). */
  expectedLeaguePoints: number;
  actualLeaguePoints: number;
  /** > 0 = fortunato, < 0 = derubato. */
  luckDelta: number;
  regret: RegretBreakdown | undefined;
};

export function buildTeamViews(ctx: FactContext): Map<string, TeamView> {
  const { result } = ctx;
  const views = new Map<string, TeamView>();

  const entries: { teamId: string; score: TeamScore; opponentId: string; isHome: boolean; outcome: 'W' | 'D' | 'L' }[] = [];
  for (const f of result.fixtures) {
    entries.push({
      teamId: f.homeTeamId, score: f.homeScore, opponentId: f.awayTeamId, isHome: true,
      outcome: f.outcome === 'home' ? 'W' : f.outcome === 'away' ? 'L' : 'D',
    });
    entries.push({
      teamId: f.awayTeamId, score: f.awayScore, opponentId: f.homeTeamId, isHome: false,
      outcome: f.outcome === 'away' ? 'W' : f.outcome === 'home' ? 'L' : 'D',
    });
  }

  const allPoints = entries.map((e) => e.score.total);
  const ranked = [...allPoints].sort((a, b) => b - a);

  for (const e of entries) {
    const others = entries.filter((o) => o.teamId !== e.teamId);
    let vw = 0;
    let vd = 0;
    for (const o of others) {
      if (e.score.total > o.score.total) vw++;
      else if (e.score.total === o.score.total) vd++;
    }
    const vl = others.length - vw - vd;
    const expected = others.length === 0 ? 0 : round2((3 * vw + vd) / others.length);
    const actual = e.outcome === 'W' ? 3 : e.outcome === 'D' ? 1 : 0;
    const opponent = entries.find((o) => o.teamId === e.opponentId);

    views.set(e.teamId, {
      teamId: e.teamId,
      score: e.score,
      points: e.score.total,
      goals: e.score.goals,
      opponentId: e.opponentId,
      opponentPoints: opponent?.score.total ?? 0,
      opponentGoals: opponent?.score.goals ?? 0,
      isHome: e.isHome,
      outcome: e.outcome,
      pointsMargin: round2(Math.abs(e.score.total - (opponent?.score.total ?? 0))),
      rank: ranked.indexOf(e.score.total) + 1,
      virtualWins: vw,
      virtualDraws: vd,
      virtualLosses: vl,
      expectedLeaguePoints: expected,
      actualLeaguePoints: actual,
      luckDelta: round2(actual - expected),
      regret: result.regrets.get(e.teamId),
    });
  }
  return views;
}
