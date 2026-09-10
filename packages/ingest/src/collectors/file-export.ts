import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';

/**
 * Esportazione nello stesso formato che l'importatore accetta.
 *
 * Serve a due cose reali: dare all'admin i suoi dati in un formato che può
 * aprire e correggere, e rendere verificabile per round-trip l'intero strato
 * di ingestion — se esportare e reimportare non restituisce gli stessi
 * punteggi, il difetto è qui e non a valle.
 */

function cell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => cell(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

export function exportVoti(serieA: SerieAMatchday): string {
  return toCsv(
    ['playerId', 'playerName', 'role', 'serieATeam', 'vote', 'minutes', 'goals', 'ownGoals',
     'assists', 'penaltiesScored', 'penaltiesMissed', 'penaltiesSaved', 'yellowCards',
     'redCards', 'goalsConceded', 'xG'],
    serieA.players.map((p) => ({
      playerId: p.playerId, playerName: p.playerName, role: p.role, serieATeam: p.serieATeam,
      vote: p.vote, minutes: p.minutes,
      goals: p.events.goals, ownGoals: p.events.ownGoals, assists: p.events.assists,
      penaltiesScored: p.events.penaltiesScored, penaltiesMissed: p.events.penaltiesMissed,
      penaltiesSaved: p.events.penaltiesSaved, yellowCards: p.events.yellowCards,
      redCards: p.events.redCards, goalsConceded: p.events.goalsConceded, xG: p.xG,
    })),
  );
}

export function exportFormazioni(snapshot: LeagueWeekSnapshot): string {
  const teams = new Map(snapshot.teams.map((t) => [t.teamId, t]));
  const rows: Record<string, unknown>[] = [];

  for (const lineup of snapshot.lineups) {
    const team = teams.get(lineup.teamId);
    const base = {
      teamId: lineup.teamId,
      teamName: team?.teamName ?? lineup.teamId,
      managerName: team?.managerName ?? '',
      module: lineup.module,
      autoFilled: lineup.autoFilled ? '1' : '',
    };
    lineup.starters.forEach((s, i) => rows.push({
      ...base, position: `T${i + 1}`, playerId: s.playerId, role: s.role,
      captain: lineup.captainId === s.playerId ? '1' : '',
      vice: lineup.viceCaptainId === s.playerId ? '1' : '',
    }));
    // L'ordine di panchina è significativo: determina le sostituzioni.
    lineup.bench.forEach((s, i) => rows.push({
      ...base, position: `P${i + 1}`, playerId: s.playerId, role: s.role,
      captain: '', vice: '',
    }));
  }

  return toCsv(
    ['teamId', 'teamName', 'managerName', 'module', 'position', 'playerId', 'role', 'captain', 'vice', 'autoFilled'],
    rows,
  );
}

export function exportCalendario(snapshot: LeagueWeekSnapshot): string {
  return toCsv(
    ['homeTeamId', 'awayTeamId', 'officialHomePoints', 'officialAwayPoints', 'officialHomeGoals', 'officialAwayGoals'],
    snapshot.fixtures.map((f) => ({ ...f })),
  );
}

export function exportRose(snapshot: LeagueWeekSnapshot): string {
  const rows = snapshot.teams.flatMap((t) =>
    t.roster.map((r) => ({ teamId: t.teamId, playerId: r.playerId, purchasePrice: r.purchasePrice })));
  return toCsv(['teamId', 'playerId', 'purchasePrice'], rows);
}

export function exportClassifica(snapshot: LeagueWeekSnapshot): string {
  return toCsv(
    ['teamId', 'position', 'points', 'totalFantasyPoints'],
    snapshot.standingsBefore.map((r) => ({ ...r })),
  );
}

export function exportPartiteSerieA(serieA: SerieAMatchday): string {
  return toCsv(
    ['homeTeam', 'awayTeam', 'homeGoals', 'awayGoals'],
    serieA.matches.map((m) => ({
      homeTeam: m.homeTeam, awayTeam: m.awayTeam, homeGoals: m.homeGoals, awayGoals: m.awayGoals,
    })),
  );
}

/** Il pacchetto completo: quello che l'admin scarica e che l'importatore legge. */
export function exportAll(serieA: SerieAMatchday, snapshot: LeagueWeekSnapshot): {
  votiCsv: string; formazioniCsv: string; calendarioCsv: string;
  roseCsv: string; classificaCsv: string; partiteSerieACsv: string;
} {
  return {
    votiCsv: exportVoti(serieA),
    formazioniCsv: exportFormazioni(snapshot),
    calendarioCsv: exportCalendario(snapshot),
    roseCsv: exportRose(snapshot),
    classificaCsv: exportClassifica(snapshot),
    partiteSerieACsv: exportPartiteSerieA(serieA),
  };
}
