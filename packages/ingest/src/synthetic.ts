import type {
  LeagueWeekSnapshot, PlayerMatchStat, Role, SerieAMatchday, LineupSlot, Lineup, LeagueTeam,
} from '@fantacomics/core';
import { LeagueWeekSnapshotSchema, SerieAMatchdaySchema, parseModule, seededRandom, stableHash } from '@fantacomics/core';
import { computeTeamScore, indexStats } from '@fantacomics/scoring';

const SERIE_A_TEAMS = [
  'ATA', 'BOL', 'CAG', 'COM', 'EMP', 'FIO', 'GEN', 'INT', 'JUV', 'LAZ',
  'LEC', 'MIL', 'MON', 'NAP', 'PAR', 'ROM', 'TOR', 'UDI', 'VEN', 'VER',
];

const ROLE_COUNTS: Record<Role, number> = { P: 3, D: 8, C: 8, A: 6 };

const NOMI = ['Alberti', 'Bianchi', 'Colombo', 'De Santis', 'Esposito', 'Ferrari', 'Gallo', 'Hidalgo',
  'Iacobelli', 'Jovic', 'Konate', 'Lombardi', 'Marchetti', 'Neri', 'Oduya', 'Parisi', 'Quaranta',
  'Rossi', 'Santoro', 'Traore', 'Ubaldi', 'Vitale', 'Wagner', 'Ximenes', 'Yildiz', 'Zanetti'];

const SQUADRE_FANTA = [
  'Real Sporcaccioni', 'AC Panchina Lunga', 'Gli Sfigati FC', 'Dinamo Divano',
  'Athletic Bilbao Rotto', 'Union Berlino Sud', 'FC Zero Tituli', 'Sporting Rimpianto',
  'Deportivo La Coruzione', 'Bayern Mai Vinto',
];

const PRESIDENTI = ['Marco', 'Giulia', 'Luca', 'Sara', 'Andrea', 'Chiara', 'Matteo', 'Elena', 'Davide', 'Francesca'];

/** Voto gaussiano troncato ai mezzi punti, come i voti veri. */
function gaussVote(rnd: () => number, mean = 6, sd = 0.75): number {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const raw = mean + z * sd;
  return Math.min(9, Math.max(4, Math.round(raw * 2) / 2));
}

export type SyntheticOptions = {
  seed: string;
  season?: string;
  matchday?: number;
  teams?: number;
  /** Forza scenari drammatici specifici, per validare i detector su casi reali. */
  scenarios?: {
    /** Una squadra chiude a 71.5: la beffa citata dall'utente. */
    beffa715?: boolean;
    /** Una squadra ha un fuoriclasse in panchina. */
    panchinaDOro?: boolean;
    /** Una squadra non schiera la formazione. */
    formazioneNonSchierata?: boolean;
  };
};

export type SyntheticWorld = {
  serieA: SerieAMatchday;
  snapshot: LeagueWeekSnapshot;
};

/** Genera un mondo completo e deterministico: stesso seed => stessi dati. */
export function generateWorld(opts: SyntheticOptions): SyntheticWorld {
  const rnd = seededRandom(opts.seed);
  const season = opts.season ?? '2025-26';
  const matchday = opts.matchday ?? 12;
  const teamCount = Math.max(2, (opts.teams ?? 8) - ((opts.teams ?? 8) % 2));

  const players = buildPlayers(rnd);
  const serieA = SerieAMatchdaySchema.parse({
    season,
    matchday,
    readiness: 'VOTI_DEFINITIVI',
    contentHash: stableHash(`${opts.seed}:${season}:${matchday}`),
    fetchedAt: '2026-01-06T07:30:00+01:00',
    matches: buildMatches(rnd),
    players,
  });

  const snapshot = buildLeague(rnd, players, {
    season, matchday, teamCount, seed: opts.seed, scenarios: opts.scenarios ?? {},
  });

  return { serieA, snapshot };
}

function buildPlayers(rnd: () => number): PlayerMatchStat[] {
  const out: PlayerMatchStat[] = [];
  let n = 0;
  for (const team of SERIE_A_TEAMS) {
    for (const [role, count] of Object.entries(ROLE_COUNTS) as [Role, number][]) {
      for (let i = 0; i < count; i++) {
        n++;
        const playerId = `p${n}`;
        const surname = NOMI[n % NOMI.length] ?? 'Rossi';
        const played = rnd() > 0.28;
        const vote = played ? gaussVote(rnd) : null;

        const goalChance = role === 'A' ? 0.16 : role === 'C' ? 0.07 : role === 'D' ? 0.03 : 0;
        const goals = played && rnd() < goalChance ? (rnd() < 0.12 ? 2 : 1) : 0;
        const assists = played && rnd() < (role === 'C' ? 0.1 : 0.05) ? 1 : 0;
        const yellow = played && rnd() < 0.16 ? 1 : 0;
        const red = played && rnd() < 0.012 ? 1 : 0;
        const conceded = role === 'P' && played ? (rnd() < 0.3 ? 0 : Math.floor(rnd() * 4)) : 0;
        const ownGoal = played && role !== 'P' && rnd() < 0.008 ? 1 : 0;

        // xG coerente con i gol, con rumore: serve a generare sotto/sovra-performance vere.
        const baseXG = role === 'A' ? 0.45 : role === 'C' ? 0.18 : role === 'D' ? 0.07 : 0;
        const xG = played ? Math.round((baseXG * (0.3 + rnd() * 2.4) + goals * 0.28 * rnd()) * 100) / 100 : null;

        out.push({
          playerId,
          playerName: `${surname} ${String.fromCharCode(65 + (n % 26))}.`,
          role,
          serieATeam: team,
          vote,
          minutes: played ? (red ? Math.floor(rnd() * 80) + 5 : 90) : 0,
          events: {
            goals, ownGoals: ownGoal, assists,
            penaltiesScored: 0, penaltiesMissed: played && rnd() < 0.012 ? 1 : 0,
            penaltiesSaved: role === 'P' && played && rnd() < 0.03 ? 1 : 0,
            yellowCards: yellow, redCards: red, goalsConceded: conceded,
          },
          xG, xA: null, officialFantaVote: null,
        });
      }
    }
  }
  return out;
}

function buildMatches(rnd: () => number) {
  const matches = [];
  for (let i = 0; i < SERIE_A_TEAMS.length; i += 2) {
    matches.push({
      homeTeam: SERIE_A_TEAMS[i] as string,
      awayTeam: SERIE_A_TEAMS[i + 1] as string,
      homeGoals: Math.floor(rnd() * 4),
      awayGoals: Math.floor(rnd() * 3),
      kickoff: null,
    });
  }
  return matches;
}

function buildLeague(
  rnd: () => number,
  players: readonly PlayerMatchStat[],
  cfg: {
    season: string; matchday: number; teamCount: number; seed: string;
    scenarios: NonNullable<SyntheticOptions['scenarios']>;
  },
): LeagueWeekSnapshot {
  const pools: Record<Role, PlayerMatchStat[]> = { P: [], D: [], C: [], A: [] };
  for (const p of players) pools[p.role].push(p);
  for (const list of Object.values(pools)) shuffle(list, rnd);

  const cursor: Record<Role, number> = { P: 0, D: 0, C: 0, A: 0 };
  const take = (role: Role, n: number): PlayerMatchStat[] => {
    const out = pools[role].slice(cursor[role], cursor[role] + n);
    cursor[role] += n;
    return out;
  };

  const teams: LeagueTeam[] = [];
  const lineups: Lineup[] = [];
  const modules = ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-3-2'];

  for (let t = 0; t < cfg.teamCount; t++) {
    const teamId = `t${t + 1}`;
    const roster = [
      ...take('P', 3), ...take('D', 8), ...take('C', 8), ...take('A', 6),
    ];

    const module = modules[Math.floor(rnd() * modules.length)] ?? '3-4-3';
    const shape = parseModule(module);

    const byRole = (role: Role) => roster.filter((p) => p.role === role);
    // Lo schieramento è "umano": si sceglie a naso, non con l'XI ottimale.
    const pick = (role: Role, n: number): PlayerMatchStat[] => {
      const list = [...byRole(role)].sort(() => rnd() - 0.5);
      return list.slice(0, n);
    };

    const gk = pick('P', 1);
    const def = pick('D', shape.defenders);
    const mid = pick('C', shape.midfielders);
    const att = pick('A', shape.forwards);
    const startersPlayers = [...gk, ...def, ...mid, ...att];
    const startersIds = new Set(startersPlayers.map((p) => p.playerId));
    const benchPlayers = roster.filter((p) => !startersIds.has(p.playerId)).slice(0, 7);

    const toSlot = (p: PlayerMatchStat): LineupSlot => ({ playerId: p.playerId, role: p.role });

    lineups.push({
      teamId,
      module,
      starters: startersPlayers.map(toSlot),
      bench: benchPlayers.map(toSlot),
      captainId: null,
      viceCaptainId: null,
      autoFilled: cfg.scenarios.formazioneNonSchierata === true && t === cfg.teamCount - 1,
    });

    teams.push({
      teamId,
      teamName: SQUADRE_FANTA[t % SQUADRE_FANTA.length] ?? `Squadra ${t + 1}`,
      managerName: PRESIDENTI[t % PRESIDENTI.length] ?? `Presidente ${t + 1}`,
      roster: roster.map((p) => ({
        playerId: p.playerId,
        purchasePrice: Math.max(1, Math.round((p.role === 'A' ? 60 : p.role === 'C' ? 35 : 20) * (0.2 + rnd() * 2.2))),
      })),
    });
  }

  const fixtures = [];
  for (let i = 0; i < teams.length; i += 2) {
    fixtures.push({
      homeTeamId: teams[i]?.teamId as string,
      awayTeamId: teams[i + 1]?.teamId as string,
      officialHomePoints: null, officialAwayPoints: null,
      officialHomeGoals: null, officialAwayGoals: null,
    });
  }

  const standingsBefore = teams.map((t, i) => ({
    teamId: t.teamId,
    position: i + 1,
    points: Math.max(0, (cfg.matchday - 1) * 3 - i * 2 - Math.floor(rnd() * 4)),
    totalFantasyPoints: Math.round((cfg.matchday - 1) * (62 + rnd() * 10) * 10) / 10,
  })).sort((a, b) => b.points - a.points)
    .map((r, i) => ({ ...r, position: i + 1 }));

  return LeagueWeekSnapshotSchema.parse({
    schemaVersion: 1,
    leagueId: `lega-${stableHash(cfg.seed)}`,
    leagueName: 'Lega dei Miracoli Mancati',
    season: cfg.season,
    matchday: cfg.matchday,
    collector: 'synthetic',
    collectedAt: '2026-01-06T08:00:00+01:00',
    teams, lineups, fixtures, standingsBefore,
  });
}

function shuffle<T>(arr: T[], rnd: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a !== undefined && b !== undefined) {
      arr[i] = b;
      arr[j] = a;
    }
  }
}

/**
 * Riempie i punteggi "ufficiali" nello snapshot sintetico calcolandoli con il
 * ruleset, così che la riconciliazione abbia qualcosa da verificare e il
 * mondo generato sia internamente coerente.
 */
export function withOfficialScores(
  world: SyntheticWorld,
  rules: import('@fantacomics/core').LeagueRuleset,
): SyntheticWorld {
  const stats = indexStats(world.serieA.players);
  const homeIds = new Set(world.snapshot.fixtures.map((f) => f.homeTeamId));
  const scores = new Map(
    world.snapshot.lineups.map((l) => [
      l.teamId,
      computeTeamScore(l, stats, rules, { isHome: homeIds.has(l.teamId) }),
    ]),
  );

  const fixtures = world.snapshot.fixtures.map((f) => {
    const home = scores.get(f.homeTeamId);
    const away = scores.get(f.awayTeamId);
    return {
      ...f,
      officialHomePoints: home?.total ?? null,
      officialAwayPoints: away?.total ?? null,
      officialHomeGoals: home?.goals ?? null,
      officialAwayGoals: away?.goals ?? null,
    };
  });

  return { ...world, snapshot: { ...world.snapshot, fixtures } };
}

/**
 * Sposta il punteggio di una squadra ESATTAMENTE su un valore obiettivo,
 * ritoccando i voti sulla griglia dei mezzi punti (come i voti veri).
 *
 * Serve a costruire scenari deterministici — la beffa del 71.5 su tutte —
 * senza aspettare che il caso li produca: un detector di punta va testato
 * su un caso che esiste per costruzione, non per fortuna.
 *
 * Due accortezze non ovvie:
 * 1. si ritoccano solo i ruoli SENZA modificatore attivo, perche' il
 *    modificatore si muove a scatti di banda e non e' lineare nel voto;
 * 2. il totale si ricalcola dopo ogni passo invece di scalare un contatore,
 *    cosi' ogni effetto collaterale viene assorbito invece di accumularsi.
 */
export function nudgeTeamToScore(
  world: SyntheticWorld,
  teamId: string,
  target: number,
  rules: import('@fantacomics/core').LeagueRuleset,
  opts: { strict?: boolean } = {},
): SyntheticWorld {
  const strict = opts.strict !== false;
  const lineup = world.snapshot.lineups.find((l) => l.teamId === teamId);
  if (!lineup) {
    if (strict) throw new Error(`nudgeTeamToScore: squadra ${teamId} inesistente`);
    return world;
  }

  const players = world.serieA.players.map((p) => ({ ...p, events: { ...p.events } }));
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const isHome = world.snapshot.fixtures.some((f) => f.homeTeamId === teamId);
  const scoreNow = () => computeTeamScore(lineup, indexStats(players), rules, { isHome });

  // I ruoli senza modificatore attivo sono LINEARI nel voto: si toccano per
  // primi perche' ogni mezzo punto vale esattamente mezzo punto.
  const linearRoles = new Set<Role>(['C', 'A']);
  if (rules.midfieldModifier?.enabled) linearRoles.delete('C');
  if (rules.attackModifier?.enabled) linearRoles.delete('A');

  const inXI = scoreNow().effective.slots;
  const rated = (s: { playerId: string }) => {
    const p = byId.get(s.playerId);
    return p !== undefined && p.vote !== null ? p : undefined;
  };
  const linear = inXI.filter((s) => linearRoles.has(s.role)).map(rated)
    .filter((p): p is PlayerMatchStat => p !== undefined);
  const rest = inXI.filter((s) => !linearRoles.has(s.role)).map(rated)
    .filter((p): p is PlayerMatchStat => p !== undefined);

  const diffNow = () => Math.round((target - scoreNow().total) * 2) / 2;

  // Prima i lineari, poi tutti: il totale si ricalcola a ogni passo, cosi'
  // gli scatti di banda del modificatore vengono assorbiti invece che accumulati.
  for (const pool of [linear, [...linear, ...rest]]) {
    let guard = 0;
    while (guard++ < 4000) {
      const diff = diffNow();
      if (Math.abs(diff) < 0.5) break;
      const step = diff > 0 ? 0.5 : -0.5;
      const before = Math.abs(diff);

      const victim = pool.find((p) => {
        const next = (p.vote as number) + step;
        return next >= 4 && next <= 9.5;
      });
      if (!victim) break;

      const previous = victim.vote as number;
      victim.vote = Math.round((previous + step) * 2) / 2;

      // Un passo che peggiora la distanza (banda del modificatore) va annullato.
      if (Math.abs(diffNow()) > before) {
        victim.vote = previous;
        break;
      }
    }
    if (Math.abs(diffNow()) < 0.5) break;
  }

  const missing = diffNow();
  if (strict && Math.abs(missing) >= 0.5) {
    throw new Error(
      `nudgeTeamToScore: ${teamId} non raggiunge ${target} (fermo a ${scoreNow().total}, ` +
      `mancano ${missing}). Voti realistici esauriti: scegli un obiettivo piu' vicino.`,
    );
  }

  return { ...world, serieA: { ...world.serieA, players } };
}

/**
 * Regala una prestazione da fuoriclasse a un panchinaro che resta FUORI.
 * Sceglierlo prima delle sostituzioni non basta: se un titolare va SV, quel
 * panchinaro entra e il rimpianto sparisce — quindi si guarda chi e' rimasto
 * davvero in panchina dopo i cambi automatici.
 */
export function injectGoldenBench(
  world: SyntheticWorld,
  teamId: string,
  rules: import('@fantacomics/core').LeagueRuleset,
): SyntheticWorld {
  const lineup = world.snapshot.lineups.find((l) => l.teamId === teamId);
  if (!lineup) return world;

  const stats = indexStats(world.serieA.players);
  const isHome = world.snapshot.fixtures.some((f) => f.homeTeamId === teamId);
  const effective = computeTeamScore(lineup, stats, rules, { isHome }).effective;
  const onField = new Set(effective.slots.map((s) => s.playerId));

  // Deve avere GIA' un voto: dare un voto a un SV lo renderebbe eleggibile
  // come sostituto, facendolo entrare in campo e cancellando il rimpianto.
  const eligible = (id: string) => !onField.has(id) && stats.get(id)?.vote !== null;
  const target =
    lineup.bench.find((b) => eligible(b.playerId) && b.role === 'A') ??
    lineup.bench.find((b) => eligible(b.playerId));
  if (!target) return world;

  const players = world.serieA.players.map((p) =>
    p.playerId === target.playerId
      ? { ...p, vote: 8, minutes: 90, events: { ...p.events, goals: 2, assists: 1, redCards: 0 } }
      : p,
  );
  return { ...world, serieA: { ...world.serieA, players } };
}
