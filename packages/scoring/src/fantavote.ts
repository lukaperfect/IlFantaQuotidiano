import type { LeagueRuleset, PlayerMatchStat } from '@fantacomics/core';
import { round2 } from '@fantacomics/core';

export type StatIndex = ReadonlyMap<string, PlayerMatchStat>;

export function indexStats(players: readonly PlayerMatchStat[]): StatIndex {
  return new Map(players.map((p) => [p.playerId, p]));
}

/**
 * Fantavoto = voto + bonus/malus, secondo il regolamento DELLA LEGA.
 * Ritorna null se il giocatore è senza voto (SV): l'assenza di voto
 * non è zero, è un'informazione diversa e va propagata come tale.
 */
export function computeFantaVote(stat: PlayerMatchStat, rules: LeagueRuleset): number | null {
  if (stat.vote === null) return null;
  const b = rules.bonus;
  const e = stat.events;
  let fv = stat.vote;
  fv += e.goals * b.goal;
  fv += e.penaltiesScored * b.penaltyScored;
  fv += e.ownGoals * b.ownGoal;
  if (rules.useAssists) fv += e.assists * b.assist;
  fv += e.penaltiesMissed * b.penaltyMissed;
  fv += e.penaltiesSaved * b.penaltySaved;
  fv += e.yellowCards * b.yellowCard;
  fv += e.redCards * b.redCard;
  if (stat.role === 'P') {
    fv += e.goalsConceded * b.goalConcededGK;
    if (e.goalsConceded === 0) fv += b.cleanSheetGK;
  }
  return round2(fv);
}

/** Il fantavoto ai fini del punteggio: un SV vale 0, ma resta tracciato come SV. */
export function fantaVoteOrZero(stat: PlayerMatchStat | undefined, rules: LeagueRuleset): number {
  if (!stat) return 0;
  return computeFantaVote(stat, rules) ?? 0;
}
