import type { LeagueRuleset, LineupSlot, Role } from '@fantacomics/core';
import { parseModule, round2 } from '@fantacomics/core';
import { computeFantaVote, type StatIndex } from './fantavote.js';
import { computeModifier } from './modifier.js';
import type { TeamScore } from './score.js';

type Candidate = { playerId: string; role: Role; fv: number; vote: number | null };

/** Enumerazione di combinazioni con tetto di sicurezza. */
function combinations<T>(pool: readonly T[], k: number, cap = 50_000): T[][] {
  if (k < 0 || k > pool.length) return [];
  if (k === 0) return [[]];
  const out: T[][] = [];
  const cur: T[] = [];
  let overflow = false;
  const walk = (start: number) => {
    if (overflow) return;
    if (cur.length === k) {
      if (out.length >= cap) { overflow = true; return; }
      out.push([...cur]);
      return;
    }
    for (let i = start; i < pool.length && !overflow; i++) {
      const item = pool[i];
      if (item === undefined) continue;
      cur.push(item);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

function buildCandidates(
  playerIds: readonly string[],
  stats: StatIndex,
  rules: LeagueRuleset,
): Map<Role, Candidate[]> {
  const byRole = new Map<Role, Candidate[]>([['P', []], ['D', []], ['C', []], ['A', []]]);
  const seen = new Set<string>();
  for (const id of playerIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const st = stats.get(id);
    if (!st) continue;
    /**
     * Anche gli SV entrano, valutati 0.
     *
     * Escluderli sembrava giusto (un SV non e' mai la scelta migliore) ma
     * rendeva l'ottimo INCALCOLABILE per chi aveva il portiere senza voto —
     * e quella squadra perdeva in silenzio tutti i fatti sul rimpianto.
     * Un XI reale un portiere lo deve schierare comunque, quindi l'ottimo
     * si calcola alle stesse condizioni. Con fantavoto 0 finiscono in fondo
     * da soli, tranne quando valgono davvero piu' di un rated in negativo.
     */
    const fv = computeFantaVote(st, rules) ?? 0;
    byRole.get(st.role)?.push({ playerId: id, role: st.role, fv, vote: st.vote });
  }
  for (const list of byRole.values()) list.sort((a, b) => b.fv - a.fv);
  return byRole;
}

type GroupPick = { members: Candidate[]; score: number } | null;

/**
 * Massimizza un reparto. Se il reparto ha un modificatore attivo il greedy
 * sui fantavoti NON è ottimale (il modificatore guarda il VOTO), quindi si enumera.
 * Le cardinalità reali (C(8,4)=70) rendono l'enumerazione esatta praticamente gratuita.
 */
function bestGroup(
  pool: readonly Candidate[],
  k: number,
  role: Role,
  gk: Candidate | null,
  rules: LeagueRuleset,
  stats: StatIndex,
): GroupPick {
  if (pool.length < k) return null;
  const cfg =
    role === 'D' ? rules.defenseModifier : role === 'C' ? rules.midfieldModifier : rules.attackModifier;
  const modifierActive = cfg !== null && cfg.enabled;

  const evaluate = (members: Candidate[]): number => {
    const fvSum = members.reduce((s, c) => s + c.fv, 0) + (gk ? gk.fv : 0);
    if (!modifierActive) return fvSum;
    const slots: { playerId: string; role: Role }[] = members.map((m) => ({ playerId: m.playerId, role }));
    if (gk) slots.push({ playerId: gk.playerId, role: 'P' });
    return fvSum + computeModifier(cfg, slots, stats, role).bonus;
  };

  if (!modifierActive) {
    const members = pool.slice(0, k);
    return { members, score: round2(evaluate(members)) };
  }

  let best: GroupPick = null;
  for (const combo of combinations(pool, k)) {
    const score = evaluate(combo);
    if (!best || score > best.score) best = { members: combo, score: round2(score) };
  }
  return best;
}

export type OptimalResult = {
  feasible: boolean;
  total: number;
  module: string;
  slots: LineupSlot[];
  captainDelta: number;
};

const INFEASIBLE: OptimalResult = {
  feasible: false, total: 0, module: '', slots: [], captainDelta: 0,
};

/**
 * XI ottimale ex post. Esatto, non euristico.
 * Il totale si decompone in contributi di reparto indipendenti, quindi
 * si ottimizza ogni reparto separatamente per ciascun modulo ammesso.
 */
export function bestLineup(
  playerIds: readonly string[],
  stats: StatIndex,
  rules: LeagueRuleset,
  opts: { modules?: readonly string[]; isHome?: boolean } = {},
): OptimalResult {
  const byRole = buildCandidates(playerIds, stats, rules);
  const keepers = byRole.get('P') ?? [];
  const modules = opts.modules ?? rules.allowedModules;
  if (keepers.length === 0) return INFEASIBLE;

  let best: OptimalResult = INFEASIBLE;

  for (const module of modules) {
    let shape: { defenders: number; midfielders: number; forwards: number };
    try {
      shape = parseModule(module);
    } catch {
      continue;
    }
    for (const gk of keepers) {
      const def = bestGroup(byRole.get('D') ?? [], shape.defenders, 'D', gk, rules, stats);
      const mid = bestGroup(byRole.get('C') ?? [], shape.midfielders, 'C', null, rules, stats);
      const atk = bestGroup(byRole.get('A') ?? [], shape.forwards, 'A', null, rules, stats);
      if (!def || !mid || !atk) continue;

      const members = [...def.members, ...mid.members, ...atk.members];
      let captainDelta = 0;
      if (rules.captain.enabled) {
        // Il capitano ottimale è il fantavoto più alto dell'XI scelto.
        const topFv = Math.max(gk.fv, ...members.map((m) => m.fv));
        captainDelta =
          rules.captain.mode === 'multiplier'
            ? round2(topFv * (rules.captain.value - 1))
            : rules.captain.value;
      }
      const homeBonus = opts.isHome ? rules.homeFieldBonus : 0;
      const total = round2(def.score + mid.score + atk.score + captainDelta + homeBonus);

      if (!best.feasible || total > best.total) {
        best = {
          feasible: true,
          total,
          module,
          captainDelta,
          slots: [
            { playerId: gk.playerId, role: 'P' as Role },
            ...members.map((m) => ({ playerId: m.playerId, role: m.role })),
          ],
        };
      }
    }
  }
  return best;
}

export type RegretBreakdown = {
  actual: number;
  bestSelectedSameModule: number;
  bestSelectedAnyModule: number;
  bestFullRoster: number;
  /** Aver scelto gli 11 sbagliati tra i 18 convocati. */
  regretBench: number;
  /** Aver scelto il modulo sbagliato, a parità di giocatori. */
  regretModule: number;
  /** Aver lasciato fuori dai convocati chi andava convocato. */
  regretRoster: number;
  regretTotal: number;
  /** Il modulo migliore usando gli stessi convocati: e' questo che va citato
   *  quando si parla di rimpianto da modulo, non l'ottimo sull'intera rosa. */
  bestSelectedModule: string;
  optimalModule: string;
  optimalSlots: LineupSlot[];
  /** false se l'ottimo non e' calcolabile (es. nessun portiere con voto):
   *  in quel caso rimpianto ed efficienza NON vanno raccontati. */
  feasible: boolean;
  /** Il panchinaro simbolo: il miglior fantavoto rimasto fuori. */
  keyBenchPlayer: { playerId: string; fantaVote: number } | null;
};

/**
 * Scomposizione ADDITIVA del rimpianto. È la miniera d'oro narrativa:
 * "non hai perso per i giocatori, hai perso per il 3-4-3" è una frase
 * che si può dire solo se il numero esiste.
 */
export function computeRegret(
  score: TeamScore,
  selectedPlayerIds: readonly string[],
  rosterPlayerIds: readonly string[],
  stats: StatIndex,
  rules: LeagueRuleset,
  opts: { isHome?: boolean } = {},
): RegretBreakdown {
  const actual = score.total;
  const effModule = score.effective.effectiveModule;

  const sameModule = bestLineup(selectedPlayerIds, stats, rules, { modules: [effModule], ...opts });
  const anyModule = bestLineup(selectedPlayerIds, stats, rules, opts);
  const fullRoster = bestLineup(rosterPlayerIds, stats, rules, opts);

  const bestSelectedSameModule = sameModule.feasible ? Math.max(sameModule.total, actual) : actual;
  const bestSelectedAnyModule = anyModule.feasible
    ? Math.max(anyModule.total, bestSelectedSameModule)
    : bestSelectedSameModule;
  const bestFullRoster = fullRoster.feasible
    ? Math.max(fullRoster.total, bestSelectedAnyModule)
    : bestSelectedAnyModule;

  const onField = new Set(score.effective.slots.map((s) => s.playerId));
  let keyBenchPlayer: { playerId: string; fantaVote: number } | null = null;
  for (const id of selectedPlayerIds) {
    if (onField.has(id)) continue;
    const st = stats.get(id);
    if (!st) continue;
    const fv = computeFantaVote(st, rules);
    if (fv === null) continue;
    if (!keyBenchPlayer || fv > keyBenchPlayer.fantaVote) keyBenchPlayer = { playerId: id, fantaVote: fv };
  }

  return {
    feasible: sameModule.feasible && anyModule.feasible && fullRoster.feasible,
    bestSelectedModule: anyModule.feasible ? anyModule.module : effModule,
    actual,
    bestSelectedSameModule: round2(bestSelectedSameModule),
    bestSelectedAnyModule: round2(bestSelectedAnyModule),
    bestFullRoster: round2(bestFullRoster),
    regretBench: round2(bestSelectedSameModule - actual),
    regretModule: round2(bestSelectedAnyModule - bestSelectedSameModule),
    regretRoster: round2(bestFullRoster - bestSelectedAnyModule),
    regretTotal: round2(bestFullRoster - actual),
    optimalModule: fullRoster.feasible ? fullRoster.module : effModule,
    optimalSlots: fullRoster.slots,
    keyBenchPlayer,
  };
}
