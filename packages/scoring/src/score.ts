import type { GoalThreshold, LeagueRuleset, Lineup, LineupSlot } from '@fantacomics/core';
import { round2 } from '@fantacomics/core';
import { computeFantaVote, fantaVoteOrZero, type StatIndex } from './fantavote.js';
import { computeModifier, type ModifierOutcome } from './modifier.js';
import { applySubstitutions, type EffectiveLineup } from './lineup.js';

export type CaptainOutcome = {
  applied: boolean;
  playerId: string | null;
  usedVice: boolean;
  delta: number;
};

export type TeamScore = {
  teamId: string;
  /** Somma dei fantavoti degli 11 effettivi. */
  base: number;
  modifiers: { defense: ModifierOutcome; midfield: ModifierOutcome; attack: ModifierOutcome };
  captain: CaptainOutcome;
  homeFieldBonus: number;
  /** Il punteggio finale della squadra. */
  total: number;
  goals: number;
  effective: EffectiveLineup;
  /** Fantavoto per giocatore effettivamente in campo: alimenta top/flop. */
  perPlayer: { playerId: string; role: string; fantaVote: number | null }[];
};

export function pointsToGoals(points: number, t: GoalThreshold): number {
  if (points < t.base) return 0;
  return 1 + Math.floor((points - t.base + 1e-9) / t.step);
}

/** Punti mancanti al gol successivo. È la materia prima della "beffa del 71.5". */
export function distanceToNextGoal(points: number, t: GoalThreshold): number {
  const goals = pointsToGoals(points, t);
  const next = goals === 0 ? t.base : t.base + goals * t.step;
  return round2(next - points);
}

/** Di quanto si è superata la soglia appena agguantata. */
export function marginOverThreshold(points: number, t: GoalThreshold): number | null {
  const goals = pointsToGoals(points, t);
  if (goals === 0) return null;
  return round2(points - (t.base + (goals - 1) * t.step));
}

function applyCaptain(
  slots: readonly LineupSlot[],
  lineup: Lineup,
  stats: StatIndex,
  rules: LeagueRuleset,
): CaptainOutcome {
  const none: CaptainOutcome = { applied: false, playerId: null, usedVice: false, delta: 0 };
  const c = rules.captain;
  if (!c.enabled || !lineup.captainId) return none;

  const onField = (id: string | null) => (id ? slots.some((s) => s.playerId === id) : false);

  let chosen: string | null = null;
  let usedVice = false;
  const capStat = stats.get(lineup.captainId);
  if (onField(lineup.captainId) && capStat && capStat.vote !== null) {
    chosen = lineup.captainId;
  } else if (c.viceFallback && lineup.viceCaptainId) {
    const viceStat = stats.get(lineup.viceCaptainId);
    if (onField(lineup.viceCaptainId) && viceStat && viceStat.vote !== null) {
      chosen = lineup.viceCaptainId;
      usedVice = true;
    }
  }
  if (!chosen) return none;

  const stat = stats.get(chosen);
  const fv = stat ? computeFantaVote(stat, rules) : null;
  if (fv === null) return none;

  const delta = c.mode === 'multiplier' ? round2(fv * (c.value - 1)) : c.value;
  return { applied: true, playerId: chosen, usedVice, delta };
}

/** Punteggio di una squadra per una giornata. Funzione pura: (lineup, stats, rules) -> score. */
export function computeTeamScore(
  lineup: Lineup,
  stats: StatIndex,
  rules: LeagueRuleset,
  opts: { isHome?: boolean } = {},
): TeamScore {
  const effective = applySubstitutions(lineup, stats, rules);
  const base = round2(
    effective.slots.reduce((sum, s) => sum + fantaVoteOrZero(stats.get(s.playerId), rules), 0),
  );

  const defense = computeModifier(rules.defenseModifier, effective.slots, stats, 'D');
  const midfield = computeModifier(rules.midfieldModifier, effective.slots, stats, 'C');
  const attack = computeModifier(rules.attackModifier, effective.slots, stats, 'A');
  const captain = applyCaptain(effective.slots, lineup, stats, rules);
  const homeFieldBonus = opts.isHome ? rules.homeFieldBonus : 0;

  const total = round2(
    base + defense.bonus + midfield.bonus + attack.bonus + captain.delta + homeFieldBonus,
  );

  return {
    teamId: lineup.teamId,
    base,
    modifiers: { defense, midfield, attack },
    captain,
    homeFieldBonus,
    total,
    goals: pointsToGoals(total, rules.goalThreshold),
    effective,
    perPlayer: effective.slots.map((s) => {
      const st = stats.get(s.playerId);
      return {
        playerId: s.playerId,
        role: s.role,
        fantaVote: st ? computeFantaVote(st, rules) : null,
      };
    }),
  };
}
