import type {
  CollectorKind, LeagueTeam, LeagueWeekSnapshot, Lineup, LineupSlot, PlayerMatchStat, Role,
  SerieAMatchday,
} from '@fantacomics/core';
import { LeagueWeekSnapshotSchema, SerieAMatchdaySchema, stableHash } from '@fantacomics/core';
import { parseCsvTable, num, optionalNum, int, bool } from '../csv.js';
import { AdapterError } from '../adapter.js';

/**
 * IL COLLECTOR CHE FUNZIONA SEMPRE.
 *
 * Non è un ripiego di serie B: è l'interruttore di emergenza del prodotto.
 * Se domani la piattaforma di origine chiude gli accessi, il sistema continua
 * a funzionare in modalità manuale invece di spegnersi. Costruire su una
 * piattaforma terza senza questa via d'uscita significa costruire sulla
 * sabbia.
 */

export type FileImportInput = {
  season: string;
  matchday: number;
  leagueId: string;
  leagueName: string;
  /** playerId,playerName,role,serieATeam,vote,minutes,goals,... */
  votiCsv: string;
  /** teamId,teamName,managerName,module,position,playerId,role,captain,autoFilled */
  formazioniCsv: string;
  /** homeTeamId,awayTeamId,officialHomePoints,officialAwayPoints,... */
  calendarioCsv: string;
  /** teamId,playerId,purchasePrice (facoltativo) */
  roseCsv?: string;
  /** teamId,position,points,totalFantasyPoints (facoltativo) */
  classificaCsv?: string;
  collectedAt?: string;
  /** homeTeam,awayTeam,homeGoals,awayGoals (facoltativo) */
  partiteSerieACsv?: string;
};

const ROLES = new Set<Role>(['P', 'D', 'C', 'A']);

function asRole(value: string, context: string): Role {
  const r = value.trim().toUpperCase() as Role;
  if (!ROLES.has(r)) {
    throw new AdapterError(`Ruolo non valido "${value}" (${context}). Attesi P, D, C, A.`, 'parse', false);
  }
  return r;
}

/**
 * Un elenco di record piatti: e' la forma comune fra un CSV esportato a mano e
 * un payload JSON mappato dall'estensione. Tenere qui il confine significa che
 * le due sorgenti convergono sugli STESSI costruttori — non su due percorsi
 * che si somigliano finche' qualcuno non li fa divergere in silenzio.
 */
export type Righe = Record<string, string>[];

export type RecordImportInput = {
  season: string;
  matchday: number;
  leagueId: string;
  leagueName: string;
  collector: CollectorKind;
  /** Serve solo a rilevare che il contenuto e' cambiato, non a leggerlo. */
  contentHash: string;
  voti: Righe;
  formazioni: Righe;
  calendario: Righe;
  rose?: Righe;
  classifica?: Righe;
  partiteSerieA?: Righe;
  collectedAt?: string;
};

/**
 * Il costruttore vero. `importFromFiles` e il relay dell'estensione ci
 * arrivano entrambi: una giornata raccolta dall'estensione e la stessa
 * giornata esportata in CSV producono lo stesso identico snapshot, e c'e' un
 * test che lo verifica.
 */
export function importFromRecords(input: RecordImportInput): {
  serieA: SerieAMatchday;
  snapshot: LeagueWeekSnapshot;
} {
  const players = buildPlayers(input.voti);
  const matches = input.partiteSerieA ? buildMatches(input.partiteSerieA) : [];

  const serieA = SerieAMatchdaySchema.parse({
    season: input.season,
    matchday: input.matchday,
    readiness: 'VOTI_DEFINITIVI',
    contentHash: input.contentHash,
    fetchedAt: input.collectedAt ?? new Date().toISOString(),
    matches,
    players,
  });

  const { teams, lineups } = buildLineups(input.formazioni, input.rose);
  const fixtures = buildFixtures(input.calendario);
  const standingsBefore = input.classifica ? buildStandings(input.classifica) : [];

  const known = new Set(teams.map((t) => t.teamId));
  for (const f of fixtures) {
    for (const id of [f.homeTeamId, f.awayTeamId]) {
      if (!known.has(id)) {
        throw new AdapterError(
          `Il calendario cita la squadra "${id}" che non compare nelle formazioni.`, 'parse', false,
        );
      }
    }
  }

  const snapshot = LeagueWeekSnapshotSchema.parse({
    schemaVersion: 1,
    leagueId: input.leagueId,
    leagueName: input.leagueName,
    season: input.season,
    matchday: input.matchday,
    collector: input.collector,
    collectedAt: input.collectedAt ?? new Date().toISOString(),
    teams, lineups, fixtures, standingsBefore,
  });

  return { serieA, snapshot };
}

/** La via dai CSV: converte in righe e passa al costruttore comune. */
export function importFromFiles(input: FileImportInput): {
  serieA: SerieAMatchday;
  snapshot: LeagueWeekSnapshot;
} {
  const righe = (csv: string): Righe => parseCsvTable(csv).rows;
  return importFromRecords({
    season: input.season,
    matchday: input.matchday,
    leagueId: input.leagueId,
    leagueName: input.leagueName,
    collector: 'file-import',
    contentHash: stableHash(input.votiCsv),
    voti: righe(input.votiCsv),
    formazioni: righe(input.formazioniCsv),
    calendario: righe(input.calendarioCsv),
    ...(input.roseCsv ? { rose: righe(input.roseCsv) } : {}),
    ...(input.classificaCsv ? { classifica: righe(input.classificaCsv) } : {}),
    ...(input.partiteSerieACsv ? { partiteSerieA: righe(input.partiteSerieACsv) } : {}),
    ...(input.collectedAt ? { collectedAt: input.collectedAt } : {}),
  });
}

function buildPlayers(rows: Righe): PlayerMatchStat[] {
  if (rows.length === 0) throw new AdapterError('Il file dei voti è vuoto.', 'parse', false);

  return rows.map((r, i) => {
    const playerId = r.playerId?.trim();
    if (!playerId) throw new AdapterError(`Riga ${i + 2} dei voti senza playerId.`, 'parse', false);
    return {
      playerId,
      playerName: r.playerName?.trim() || playerId,
      role: asRole(r.role ?? '', `voti riga ${i + 2}`),
      serieATeam: r.serieATeam?.trim() || 'N/D',
      // Cella vuota = senza voto. È un'informazione, non uno zero.
      vote: optionalNum(r.vote),
      minutes: int(r.minutes, 0),
      events: {
        goals: int(r.goals), ownGoals: int(r.ownGoals), assists: int(r.assists),
        penaltiesScored: int(r.penaltiesScored), penaltiesMissed: int(r.penaltiesMissed),
        penaltiesSaved: int(r.penaltiesSaved),
        yellowCards: Math.min(1, int(r.yellowCards)), redCards: Math.min(1, int(r.redCards)),
        goalsConceded: int(r.goalsConceded),
      },
      xG: optionalNum(r.xG), xA: optionalNum(r.xA),
      officialFantaVote: optionalNum(r.officialFantaVote),
    };
  });
}

function buildMatches(rows: Righe) {
  return rows.map((r) => ({
    homeTeam: r.homeTeam?.trim() ?? '',
    awayTeam: r.awayTeam?.trim() ?? '',
    homeGoals: int(r.homeGoals),
    awayGoals: int(r.awayGoals),
    kickoff: null,
  })).filter((m) => m.homeTeam && m.awayTeam);
}

function buildLineups(rows: Righe, roseRows?: Righe): { teams: LeagueTeam[]; lineups: Lineup[] } {
  if (rows.length === 0) throw new AdapterError('Il file delle formazioni è vuoto.', 'parse', false);

  type Acc = {
    teamName: string; managerName: string; module: string; autoFilled: boolean;
    captainId: string | null; viceCaptainId: string | null;
    starters: { order: number; slot: LineupSlot }[];
    bench: { order: number; slot: LineupSlot }[];
  };
  const byTeam = new Map<string, Acc>();

  rows.forEach((r, i) => {
    const teamId = r.teamId?.trim();
    const playerId = r.playerId?.trim();
    if (!teamId || !playerId) {
      throw new AdapterError(`Riga ${i + 2} delle formazioni incompleta.`, 'parse', false);
    }
    let acc = byTeam.get(teamId);
    if (!acc) {
      acc = {
        teamName: r.teamName?.trim() || teamId,
        managerName: r.managerName?.trim() || teamId,
        module: r.module?.trim() || '',
        autoFilled: bool(r.autoFilled),
        captainId: null, viceCaptainId: null,
        starters: [], bench: [],
      };
      byTeam.set(teamId, acc);
    }
    if (bool(r.captain)) acc.captainId = playerId;
    if (bool(r.vice)) acc.viceCaptainId = playerId;

    const position = (r.position ?? '').trim().toUpperCase();
    const slot: LineupSlot = { playerId, role: asRole(r.role ?? '', `formazioni riga ${i + 2}`) };
    const order = int(position.replace(/^[TP]/, ''), 0);

    if (position.startsWith('P')) acc.bench.push({ order, slot });
    else acc.starters.push({ order, slot });
  });

  const teams: LeagueTeam[] = [];
  const lineups: Lineup[] = [];
  const rosters = roseRows ? buildRosters(roseRows) : new Map<string, LeagueTeam['roster']>();

  for (const [teamId, acc] of byTeam) {
    if (acc.starters.length !== 11) {
      throw new AdapterError(
        `La squadra "${teamId}" ha ${acc.starters.length} titolari invece di 11.`, 'parse', false,
      );
    }
    // L'ordine di panchina determina le sostituzioni: va preservato, non
    // dedotto dall'ordine delle righe nel file.
    const starters = acc.starters.sort((a, b) => a.order - b.order).map((s) => s.slot);
    const bench = acc.bench.sort((a, b) => a.order - b.order).map((s) => s.slot);

    const d = starters.filter((s) => s.role === 'D').length;
    const c = starters.filter((s) => s.role === 'C').length;
    const a = starters.filter((s) => s.role === 'A').length;
    const module = acc.module || `${d}-${c}-${a}`;

    lineups.push({
      teamId, module, starters, bench,
      captainId: acc.captainId, viceCaptainId: acc.viceCaptainId,
      autoFilled: acc.autoFilled,
    });
    teams.push({
      teamId, teamName: acc.teamName, managerName: acc.managerName,
      roster: rosters.get(teamId) ?? [...starters, ...bench].map((s) => ({ playerId: s.playerId, purchasePrice: null })),
    });
  }

  return { teams, lineups };
}

function buildRosters(rows: Righe): Map<string, LeagueTeam['roster']> {
  const out = new Map<string, LeagueTeam['roster']>();
  for (const r of rows) {
    const teamId = r.teamId?.trim();
    const playerId = r.playerId?.trim();
    if (!teamId || !playerId) continue;
    const list = out.get(teamId) ?? [];
    list.push({ playerId, purchasePrice: optionalNum(r.purchasePrice) });
    out.set(teamId, list);
  }
  return out;
}

function buildFixtures(rows: Righe) {
  if (rows.length === 0) throw new AdapterError('Il calendario è vuoto.', 'parse', false);
  return rows.map((r) => ({
    homeTeamId: r.homeTeamId?.trim() ?? '',
    awayTeamId: r.awayTeamId?.trim() ?? '',
    officialHomePoints: optionalNum(r.officialHomePoints),
    officialAwayPoints: optionalNum(r.officialAwayPoints),
    officialHomeGoals: optionalNum(r.officialHomeGoals),
    officialAwayGoals: optionalNum(r.officialAwayGoals),
  }));
}

function buildStandings(rows: Righe) {
  return rows.map((r, i) => ({
    teamId: r.teamId?.trim() ?? '',
    position: int(r.position, i + 1),
    points: int(r.points),
    totalFantasyPoints: num(r.totalFantasyPoints),
  })).filter((r) => r.teamId);
}
