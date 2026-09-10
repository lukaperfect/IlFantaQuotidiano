import type { DefenseModifier, PlayerMatchStat, Role } from '@fantacomics/core';
import { round2 } from '@fantacomics/core';
import type { StatIndex } from './fantavote.js';

export type ModifierOutcome = {
  applied: boolean;
  bonus: number;
  average: number | null;
  /** Chi è entrato nella media: alimenta i fatti "modificatore salvatore/mancato". */
  contributors: { playerId: string; vote: number }[];
  reason: string;
};

const NOT_APPLIED = (reason: string): ModifierOutcome => ({
  applied: false, bonus: 0, average: null, contributors: [], reason,
});

/**
 * Il modificatore usa il VOTO PURO, non il fantavoto.
 * È la ragione per cui l'XI ottimale non è un semplice greedy sui fantavoti:
 * un difensore da 6.5 senza bonus può valere più di uno da 6 che ha segnato.
 */
export function computeModifier(
  cfg: DefenseModifier | null,
  effectiveXI: readonly { playerId: string; role: Role }[],
  stats: StatIndex,
  targetRole: Role,
): ModifierOutcome {
  if (!cfg || !cfg.enabled) return NOT_APPLIED('modificatore disabilitato');

  const inRole = effectiveXI.filter((s) => s.role === targetRole);
  if (inRole.length < cfg.minDefenders) {
    return NOT_APPLIED(`servono almeno ${cfg.minDefenders} giocatori di ruolo ${targetRole}, schierati ${inRole.length}`);
  }

  const contributors: { playerId: string; vote: number }[] = [];

  if (cfg.includeGoalkeeper) {
    const gk = effectiveXI.find((s) => s.role === 'P');
    const gkStat = gk ? stats.get(gk.playerId) : undefined;
    if (!gkStat || gkStat.vote === null) {
      return NOT_APPLIED('portiere senza voto: modificatore non applicabile');
    }
    contributors.push({ playerId: gkStat.playerId, vote: gkStat.vote });
  }

  const rated = inRole
    .map((s) => stats.get(s.playerId))
    .filter((st): st is PlayerMatchStat => st !== undefined && st.vote !== null)
    .sort((a, b) => (b.vote ?? 0) - (a.vote ?? 0));

  if (rated.length < cfg.defendersInAverage) {
    return NOT_APPLIED(`solo ${rated.length} giocatori di ruolo ${targetRole} con voto, ne servono ${cfg.defendersInAverage}`);
  }

  for (const st of rated.slice(0, cfg.defendersInAverage)) {
    contributors.push({ playerId: st.playerId, vote: st.vote as number });
  }

  const average = round2(contributors.reduce((s, c) => s + c.vote, 0) / contributors.length);

  let bonus = 0;
  for (const band of [...cfg.bands].sort((a, b) => a.minAverage - b.minAverage)) {
    if (average >= band.minAverage) bonus = band.bonus;
  }

  return { applied: true, bonus, average, contributors, reason: 'applicato' };
}
