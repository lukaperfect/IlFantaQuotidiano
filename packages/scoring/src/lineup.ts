import type { LeagueRuleset, Lineup, LineupSlot, Role } from '@fantacomics/core';
import { parseModule } from '@fantacomics/core';
import type { StatIndex } from './fantavote.js';

export type Substitution = {
  outPlayerId: string;
  inPlayerId: string;
  role: Role;
  benchPosition: number;
};

export type EffectiveLineup = {
  /** Gli 11 che contano davvero, dopo le sostituzioni automatiche. */
  slots: LineupSlot[];
  substitutions: Substitution[];
  /** Titolari SV rimasti in campo perché i cambi sono finiti o non c'era il ruolo. */
  unreplacedSV: LineupSlot[];
  /** Il modulo effettivo dopo i cambi (può cambiare se la lega lo permette). */
  effectiveModule: string;
  /** Panchinari con voto rimasti fuori: il materiale della "panchina d'oro". */
  unusedBench: LineupSlot[];
};

function moduleOf(slots: readonly LineupSlot[]): string {
  const d = slots.filter((s) => s.role === 'D').length;
  const m = slots.filter((s) => s.role === 'C').length;
  const a = slots.filter((s) => s.role === 'A').length;
  return `${d}-${m}-${a}`;
}

function hasVote(slot: LineupSlot, stats: StatIndex): boolean {
  const st = stats.get(slot.playerId);
  return st !== undefined && st.vote !== null;
}

/**
 * Applica le sostituzioni automatiche come le applica la piattaforma:
 * in ordine di panchina, solo verso panchinari CON voto, nel limite dei cambi.
 * È il passaggio che più spesso spiega i punteggi assurdi — e va replicato
 * esattamente, altrimenti la riconciliazione fallisce.
 */
export function applySubstitutions(
  lineup: Lineup,
  stats: StatIndex,
  rules: LeagueRuleset,
): EffectiveLineup {
  const slots: LineupSlot[] = lineup.starters.map((s) => ({ ...s }));
  const substitutions: Substitution[] = [];
  const unreplacedSV: LineupSlot[] = [];
  const usedBench = new Set<number>();
  const sub = rules.substitutions;

  for (let i = 0; i < slots.length; i++) {
    const starter = slots[i];
    if (!starter || hasVote(starter, stats)) continue;

    if (substitutions.length >= sub.max) {
      unreplacedSV.push(starter);
      continue;
    }

    let replaced = false;
    for (let b = 0; b < lineup.bench.length; b++) {
      if (usedBench.has(b)) continue;
      const cand = lineup.bench[b];
      if (!cand || !hasVote(cand, stats)) continue;

      if (cand.role !== starter.role) {
        if (sub.requireSameRole && !sub.allowModuleChange) continue;
        // Ruolo diverso: ammesso solo se il modulo risultante resta legale.
        const probe = slots.map((s, idx) => (idx === i ? cand : s));
        if (starter.role === 'P' || cand.role === 'P') continue;
        if (!rules.allowedModules.includes(moduleOf(probe))) continue;
      }

      slots[i] = { ...cand };
      usedBench.add(b);
      substitutions.push({
        outPlayerId: starter.playerId,
        inPlayerId: cand.playerId,
        role: cand.role,
        benchPosition: b + 1,
      });
      replaced = true;
      break;
    }
    if (!replaced) unreplacedSV.push(starter);
  }

  const unusedBench = lineup.bench.filter((s, idx) => !usedBench.has(idx) && hasVote(s, stats));

  return {
    slots,
    substitutions,
    unreplacedSV,
    effectiveModule: moduleOf(slots),
    unusedBench,
  };
}

/** Verifica che un insieme di 11 slot rispetti un modulo dichiarato. */
export function matchesModule(slots: readonly LineupSlot[], module: string): boolean {
  const { defenders, midfielders, forwards } = parseModule(module);
  const gk = slots.filter((s) => s.role === 'P').length;
  return (
    gk === 1 &&
    slots.filter((s) => s.role === 'D').length === defenders &&
    slots.filter((s) => s.role === 'C').length === midfielders &&
    slots.filter((s) => s.role === 'A').length === forwards
  );
}
