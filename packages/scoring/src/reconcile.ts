import { round2 } from '@fantacomics/core';
import type { LeagueWeekSnapshot } from '@fantacomics/core';
import type { TeamScore } from './score.js';

export type TeamReconciliation = {
  teamId: string;
  computed: number;
  official: number | null;
  delta: number | null;
  ok: boolean;
};

export type ReconciliationReport = {
  ok: boolean;
  /** Nessun punteggio ufficiale disponibile: non si può verificare nulla. */
  unverifiable: boolean;
  tolerance: number;
  teams: TeamReconciliation[];
  worstDelta: number;
  message: string;
};

/**
 * L'ANCORA DI FIDUCIA del prodotto.
 *
 * Se il ricalcolo non combacia con il punteggio ufficiale, non si pubblica
 * un giornale "quasi giusto": si degrada. Le metriche controfattuali
 * (XI ottimale, rimpianto) vengono disattivate e si raccontano solo i
 * risultati ufficiali. Un numero sbagliato nel gruppo WhatsApp non è un bug,
 * è la fine del prodotto: qualcuno controlla, sempre.
 */
export function reconcile(
  snapshot: LeagueWeekSnapshot,
  scores: ReadonlyMap<string, TeamScore>,
  tolerance = 0.01,
): ReconciliationReport {
  const official = new Map<string, number>();
  for (const f of snapshot.fixtures) {
    if (f.officialHomePoints !== null) official.set(f.homeTeamId, f.officialHomePoints);
    if (f.officialAwayPoints !== null) official.set(f.awayTeamId, f.officialAwayPoints);
  }

  const teams: TeamReconciliation[] = [];
  for (const [teamId, score] of scores) {
    const off = official.get(teamId) ?? null;
    const delta = off === null ? null : round2(score.total - off);
    teams.push({
      teamId,
      computed: score.total,
      official: off,
      delta,
      ok: delta === null ? true : Math.abs(delta) <= tolerance,
    });
  }

  const checked = teams.filter((t) => t.delta !== null);
  const unverifiable = checked.length === 0;
  const worstDelta = checked.reduce((w, t) => Math.max(w, Math.abs(t.delta ?? 0)), 0);
  const failing = checked.filter((t) => !t.ok);
  const ok = !unverifiable && failing.length === 0;

  const message = unverifiable
    ? 'Nessun punteggio ufficiale nello snapshot: riconciliazione impossibile, metriche controfattuali disattivate.'
    : ok
      ? `Riconciliazione OK su ${checked.length} squadre (scarto massimo ${worstDelta.toFixed(2)}).`
      : `Riconciliazione FALLITA su ${failing.length}/${checked.length} squadre (scarto massimo ${worstDelta.toFixed(2)}). Edizione in modalità ridotta.`;

  return { ok, unverifiable, tolerance, teams, worstDelta, message };
}
