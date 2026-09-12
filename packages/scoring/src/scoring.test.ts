import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET, LeagueRulesetSchema, type LeagueRuleset } from '@fantacomics/core';
import { computeFantaVote, indexStats } from './fantavote.js';
import { computeTeamScore, pointsToGoals, distanceToNextGoal, marginOverThreshold } from './score.js';
import { applySubstitutions } from './lineup.js';
import { computeModifier } from './modifier.js';
import { bestLineup, computeRegret } from './optimal.js';
import { mkStat, slot, standard343, mkLineup } from './__fixtures__.js';

const R = DEFAULT_RULESET;

describe('fantavoto', () => {
  it('somma bonus gol e assist al voto', () => {
    // 6 (voto) + 3 (gol) + 1 (assist) = 10
    expect(computeFantaVote(mkStat('a1', 'A', 6, { goals: 1, assists: 1 }), R)).toBe(10);
  });

  it('un SV resta null: assenza di voto non è zero', () => {
    expect(computeFantaVote(mkStat('a1', 'A', null), R)).toBeNull();
  });

  it('premia la porta inviolata e penalizza i gol subiti', () => {
    expect(computeFantaVote(mkStat('p1', 'P', 6, { goalsConceded: 0 }), R)).toBe(7);
    expect(computeFantaVote(mkStat('p1', 'P', 6, { goalsConceded: 2 }), R)).toBe(4);
  });

  it('applica cartellini e autogol', () => {
    // 6 - 0.5 (giallo) - 2 (autogol) = 3.5
    expect(computeFantaVote(mkStat('d1', 'D', 6, { yellowCards: 1, ownGoals: 1 }), R)).toBe(3.5);
  });

  it('non conta due volte un rigore segnato con la configurazione di default', () => {
    // goals include già il rigore: 6 + 3 = 9, non 12
    expect(computeFantaVote(mkStat('a1', 'A', 6, { goals: 1, penaltiesScored: 1 }), R)).toBe(9);
  });
});

describe('soglie gol — la matematica della beffa', () => {
  it('converte punti in gol secondo base 66 / step 6', () => {
    const t = R.goalThreshold;
    expect(pointsToGoals(65.5, t)).toBe(0);
    expect(pointsToGoals(66, t)).toBe(1);
    expect(pointsToGoals(71.5, t)).toBe(1);
    expect(pointsToGoals(72, t)).toBe(2);
    expect(pointsToGoals(78, t)).toBe(3);
  });

  it('quantifica esattamente la beffa del 71.5', () => {
    expect(distanceToNextGoal(71.5, R.goalThreshold)).toBe(0.5);
    expect(marginOverThreshold(71.5, R.goalThreshold)).toBe(5.5);
  });

  it('sotto la soglia base misura la distanza dal primo gol', () => {
    expect(distanceToNextGoal(65.5, R.goalThreshold)).toBe(0.5);
    expect(marginOverThreshold(65.5, R.goalThreshold)).toBeNull();
  });

  it('rispetta soglie di lega non standard', () => {
    const custom = { base: 60, step: 4 };
    expect(pointsToGoals(60, custom)).toBe(1);
    expect(pointsToGoals(63.9, custom)).toBe(1);
    expect(pointsToGoals(64, custom)).toBe(2);
  });
});

describe('modificatore difesa', () => {
  const withDef = (votes: number[], gkVote: number | null) => {
    const stats = indexStats([
      mkStat('p1', 'P', gkVote),
      ...votes.map((v, i) => mkStat(`d${i + 1}`, 'D', v)),
    ]);
    const xi = [
      { playerId: 'p1', role: 'P' as const },
      ...votes.map((_, i) => ({ playerId: `d${i + 1}`, role: 'D' as const })),
    ];
    return computeModifier(R.defenseModifier, xi, stats, 'D');
  };

  it('usa il voto puro e prende i 3 difensori migliori', () => {
    // portiere 7 + difensori 7,7,7 (il 5 resta fuori) => media 7 => +4
    const out = withDef([7, 7, 7, 5], 7);
    expect(out.applied).toBe(true);
    expect(out.average).toBe(7);
    expect(out.bonus).toBe(4);
  });

  it('non si applica sotto il numero minimo di difensori', () => {
    const out = withDef([7, 7, 7], 7); // solo 3 difensori, ne servono 4
    expect(out.applied).toBe(false);
    expect(out.bonus).toBe(0);
  });

  it('non si applica se il portiere è senza voto', () => {
    const out = withDef([7, 7, 7, 7], null);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain('portiere');
  });

  it('sotto media 6 non dà nulla', () => {
    const out = withDef([5.5, 5.5, 5.5, 5.5], 5.5);
    expect(out.applied).toBe(true);
    expect(out.bonus).toBe(0);
  });
});

describe('sostituzioni automatiche', () => {
  const stats = indexStats([
    mkStat('p1', 'P', 6), mkStat('d1', 'D', 6), mkStat('d2', 'D', 6), mkStat('d3', 'D', 6),
    mkStat('c1', 'C', null), mkStat('c2', 'C', 6), mkStat('c3', 'C', 6), mkStat('c4', 'C', 6),
    mkStat('a1', 'A', null), mkStat('a2', 'A', 6), mkStat('a3', 'A', 6),
    mkStat('pan1', 'C', 7), mkStat('pan2', 'A', null), mkStat('pan3', 'A', 8),
  ]);

  it('sostituisce gli SV rispettando ruolo e ordine di panchina', () => {
    const lineup = standard343('T1', [slot('pan1', 'C'), slot('pan2', 'A'), slot('pan3', 'A')]);
    const eff = applySubstitutions(lineup, stats, R);
    expect(eff.substitutions).toHaveLength(2);
    expect(eff.substitutions[0]?.inPlayerId).toBe('pan1');
    // pan2 è SV e viene saltato: entra pan3
    expect(eff.substitutions[1]?.inPlayerId).toBe('pan3');
    expect(eff.unreplacedSV).toHaveLength(0);
  });

  it('lascia in campo gli SV quando i cambi sono esauriti', () => {
    const tight: LeagueRuleset = LeagueRulesetSchema.parse({
      ...R, substitutions: { max: 1, requireSameRole: true, allowModuleChange: false },
    });
    const lineup = standard343('T1', [slot('pan1', 'C'), slot('pan3', 'A')]);
    const eff = applySubstitutions(lineup, stats, tight);
    expect(eff.substitutions).toHaveLength(1);
    expect(eff.unreplacedSV.map((s) => s.playerId)).toEqual(['a1']);
  });

  it('segnala i panchinari con voto rimasti fuori', () => {
    const lineup = standard343('T1', [slot('pan1', 'C'), slot('pan3', 'A')]);
    const eff = applySubstitutions(lineup, stats, R);
    expect(eff.unusedBench).toHaveLength(0);
    const noSV = mkLineup('T2', standard343('T2').starters.map((s) =>
      s.playerId === 'c1' ? slot('c2', 'C') : s.playerId === 'a1' ? slot('a2', 'A') : s,
    ), [slot('pan3', 'A')]);
    const eff2 = applySubstitutions(noSV, stats, R);
    expect(eff2.unusedBench.map((s) => s.playerId)).toEqual(['pan3']);
  });
});

describe('punteggio di squadra', () => {
  it('somma fantavoti e modificatore', () => {
    const stats = indexStats([
      mkStat('p1', 'P', 7, { goalsConceded: 0 }), // 7 + 1 = 8
      mkStat('d1', 'D', 7), mkStat('d2', 'D', 7), mkStat('d3', 'D', 7),
      mkStat('c1', 'C', 6), mkStat('c2', 'C', 6), mkStat('c3', 'C', 6), mkStat('c4', 'C', 6),
      mkStat('a1', 'A', 6), mkStat('a2', 'A', 6), mkStat('a3', 'A', 6),
    ]);
    const score = computeTeamScore(standard343('T1'), stats, R);
    // base = 8 + 21 + 24 + 18 = 71 ; modificatore non si applica (solo 3 difensori)
    expect(score.base).toBe(71);
    expect(score.modifiers.defense.applied).toBe(false);
    expect(score.total).toBe(71);
    expect(score.goals).toBe(1);
    expect(distanceToNextGoal(score.total, R.goalThreshold)).toBe(1);
  });

  it('applica il capitano quando previsto dal regolamento', () => {
    const rules: LeagueRuleset = LeagueRulesetSchema.parse({
      ...R, captain: { enabled: true, mode: 'multiplier', value: 2, viceFallback: true },
    });
    const stats = indexStats([
      mkStat('p1', 'P', 6, { goalsConceded: 1 }),
      mkStat('d1', 'D', 6), mkStat('d2', 'D', 6), mkStat('d3', 'D', 6),
      mkStat('c1', 'C', 6), mkStat('c2', 'C', 6), mkStat('c3', 'C', 6), mkStat('c4', 'C', 6),
      mkStat('a1', 'A', 6, { goals: 1 }), mkStat('a2', 'A', 6), mkStat('a3', 'A', 6),
    ]);
    const base = computeTeamScore(standard343('T1'), stats, rules);
    const withCap = computeTeamScore(
      mkLineup('T1', standard343('T1').starters, [], { captainId: 'a1' }), stats, rules,
    );
    expect(withCap.captain.applied).toBe(true);
    expect(withCap.total - base.total).toBe(9); // a1 vale 9, raddoppiato => +9
  });

  it('ripiega sul vice se il capitano è senza voto', () => {
    const rules: LeagueRuleset = LeagueRulesetSchema.parse({
      ...R, captain: { enabled: true, mode: 'multiplier', value: 2, viceFallback: true },
    });
    const stats = indexStats([
      mkStat('p1', 'P', 6, { goalsConceded: 1 }),
      mkStat('d1', 'D', 6), mkStat('d2', 'D', 6), mkStat('d3', 'D', 6),
      mkStat('c1', 'C', 6), mkStat('c2', 'C', 6), mkStat('c3', 'C', 6), mkStat('c4', 'C', 6),
      mkStat('a1', 'A', null), mkStat('a2', 'A', 7), mkStat('a3', 'A', 6),
    ]);
    const s = computeTeamScore(
      mkLineup('T1', standard343('T1').starters, [], { captainId: 'a1', viceCaptainId: 'a2' }),
      stats, rules,
    );
    expect(s.captain.usedVice).toBe(true);
    expect(s.captain.delta).toBe(7);
  });
});

describe('XI ottimale e rimpianto', () => {
  const stats = indexStats([
    mkStat('p1', 'P', 6, { goalsConceded: 1 }),
    mkStat('d1', 'D', 6), mkStat('d2', 'D', 6), mkStat('d3', 'D', 6), mkStat('d4', 'D', 7.5),
    mkStat('c1', 'C', 6), mkStat('c2', 'C', 6), mkStat('c3', 'C', 6), mkStat('c4', 'C', 6),
    mkStat('a1', 'A', 5), mkStat('a2', 'A', 6), mkStat('a3', 'A', 6),
    mkStat('banco', 'A', 6, { goals: 2 }), // fantavoto 12: il rimpianto in persona
  ]);
  const lineup = standard343('T1', [slot('banco', 'A'), slot('d4', 'D')]);
  const selected = [...lineup.starters, ...lineup.bench].map((s) => s.playerId);

  it('trova un XI almeno pari a quello schierato', () => {
    const actual = computeTeamScore(lineup, stats, R);
    const best = bestLineup(selected, stats, R);
    expect(best.feasible).toBe(true);
    expect(best.total).toBeGreaterThanOrEqual(actual.total);
  });

  it('scompone il rimpianto in modo additivo', () => {
    const actual = computeTeamScore(lineup, stats, R);
    const r = computeRegret(actual, selected, selected, stats, R);
    expect(r.regretBench + r.regretModule + r.regretRoster).toBeCloseTo(r.regretTotal, 6);
    expect(r.regretTotal).toBeGreaterThan(0);
    expect(r.keyBenchPlayer?.playerId).toBe('banco');
    expect(r.keyBenchPlayer?.fantaVote).toBe(12);
  });

  it('isola il rimpianto da modulo quando basta cambiare assetto', () => {
    // Con d4 (7.5) in panchina, passare a 4 difensori attiva il modificatore.
    const actual = computeTeamScore(lineup, stats, R);
    const r = computeRegret(actual, selected, selected, stats, R);
    expect(r.regretModule).toBeGreaterThan(0);
  });

  it('non produce mai rimpianto negativo', () => {
    const actual = computeTeamScore(lineup, stats, R);
    const r = computeRegret(actual, selected, selected, stats, R);
    for (const v of [r.regretBench, r.regretModule, r.regretRoster, r.regretTotal]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
