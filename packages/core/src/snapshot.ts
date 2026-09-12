import { z } from 'zod';

/**
 * GLOBAL PLANE — dati di Serie A, identici per tutte le leghe.
 * Si scaricano UNA volta per giornata, non una volta per lega.
 */

export const RoleSchema = z.enum(['P', 'D', 'C', 'A']);
export type Role = z.infer<typeof RoleSchema>;

/** Eventi grezzi. Il fantavoto NON è nello snapshot: lo calcola il ruleset. */
export const PlayerEventsSchema = z.object({
  goals: z.number().int().min(0).default(0),
  ownGoals: z.number().int().min(0).default(0),
  assists: z.number().int().min(0).default(0),
  penaltiesScored: z.number().int().min(0).default(0),
  penaltiesMissed: z.number().int().min(0).default(0),
  penaltiesSaved: z.number().int().min(0).default(0),
  yellowCards: z.number().int().min(0).max(1).default(0),
  redCards: z.number().int().min(0).max(1).default(0),
  goalsConceded: z.number().int().min(0).default(0),
});
export type PlayerEvents = z.infer<typeof PlayerEventsSchema>;

export const PlayerMatchStatSchema = z.object({
  playerId: z.string().min(1),
  playerName: z.string().min(1),
  role: RoleSchema,
  serieATeam: z.string().min(1),
  /** Voto puro. `null` = senza voto (SV): non ha giocato o non è stato valutato. */
  vote: z.number().min(0).max(10).nullable(),
  minutes: z.number().int().min(0).max(130).default(0),
  events: PlayerEventsSchema,
  /** Metriche avanzate, opzionali: alimentano i fatti su sotto/sovra-performance. */
  xG: z.number().min(0).nullable().default(null),
  xA: z.number().min(0).nullable().default(null),
  /** Fantavoto ufficiale della piattaforma, se disponibile: serve SOLO a riconciliare. */
  officialFantaVote: z.number().nullable().default(null),
});
export type PlayerMatchStat = z.infer<typeof PlayerMatchStatSchema>;

export const SerieAMatchSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  homeGoals: z.number().int().min(0),
  awayGoals: z.number().int().min(0),
  kickoff: z.string().datetime({ offset: true }).nullable().default(null),
});
export type SerieAMatch = z.infer<typeof SerieAMatchSchema>;

export const MatchdayReadinessSchema = z.enum([
  'GIORNATA_APERTA',
  'VOTI_PARZIALI',
  'VOTI_DEFINITIVI',
]);
export type MatchdayReadiness = z.infer<typeof MatchdayReadinessSchema>;

/** Lo snapshot globale: una riga per giornata di Serie A, condivisa da tutte le leghe. */
export const SerieAMatchdaySchema = z.object({
  season: z.string().regex(/^\d{4}-\d{2}$/, 'formato atteso 2025-26'),
  matchday: z.number().int().min(1).max(38),
  readiness: MatchdayReadinessSchema,
  /** Hash del contenuto: due letture consecutive uguali => voti stabili. */
  contentHash: z.string().min(1),
  fetchedAt: z.string().datetime({ offset: true }),
  matches: z.array(SerieAMatchSchema),
  players: z.array(PlayerMatchStatSchema),
});
export type SerieAMatchday = z.infer<typeof SerieAMatchdaySchema>;

/**
 * TENANT PLANE — dati della singola lega.
 * Volume basso: un fetch a settimana per lega.
 */

export const ModuleSchema = z
  .string()
  .regex(/^\d-\d-\d$/, 'modulo atteso nella forma D-C-A, es. 3-4-3');
export type Module = z.infer<typeof ModuleSchema>;

export const LineupSlotSchema = z.object({
  playerId: z.string().min(1),
  role: RoleSchema,
});
export type LineupSlot = z.infer<typeof LineupSlotSchema>;

export const LineupSchema = z.object({
  teamId: z.string().min(1),
  module: ModuleSchema,
  /** Esattamente 11, portiere incluso. */
  starters: z.array(LineupSlotSchema).length(11),
  /** Panchina ORDINATA: l'ordine determina le sostituzioni automatiche. */
  bench: z.array(LineupSlotSchema).max(15),
  captainId: z.string().nullable().default(null),
  viceCaptainId: z.string().nullable().default(null),
  /** true se l'utente non ha schierato e la piattaforma ha ricopiato l'ultima formazione. */
  autoFilled: z.boolean().default(false),
});
export type Lineup = z.infer<typeof LineupSchema>;

export const LeagueTeamSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  managerName: z.string().min(1),
  /** Rosa completa: serve per l'XI ottimale e per i fatti sul mercato. */
  roster: z.array(z.object({
    playerId: z.string().min(1),
    /** Costo d'asta, se noto: alimenta i fatti sul flop dell'asta. */
    purchasePrice: z.number().min(0).nullable().default(null),
  })).default([]),
});
export type LeagueTeam = z.infer<typeof LeagueTeamSchema>;

export const FixtureSchema = z.object({
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  /** Punteggio ufficiale mostrato dalla piattaforma: l'ancora della riconciliazione. */
  officialHomePoints: z.number().nullable().default(null),
  officialAwayPoints: z.number().nullable().default(null),
  officialHomeGoals: z.number().int().min(0).nullable().default(null),
  officialAwayGoals: z.number().int().min(0).nullable().default(null),
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const StandingRowSchema = z.object({
  teamId: z.string().min(1),
  position: z.number().int().min(1),
  points: z.number().int(),
  totalFantasyPoints: z.number(),
});
export type StandingRow = z.infer<typeof StandingRowSchema>;

export const CollectorKindSchema = z.enum([
  'serie-a-global',
  'browser-extension',
  'session-headless',
  'file-import',
  /** Dati generati: sviluppo, demo e test di carico. Mai in produzione. */
  'synthetic',
]);
export type CollectorKind = z.infer<typeof CollectorKindSchema>;

/**
 * Lo schema canonico dell'Anti-Corruption Layer.
 * Ogni collector produce QUESTO. Nulla a valle sa da dove arrivano i dati.
 */
export const LeagueWeekSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  leagueId: z.string().min(1),
  leagueName: z.string().min(1),
  season: z.string().regex(/^\d{4}-\d{2}$/),
  matchday: z.number().int().min(1).max(38),
  collector: CollectorKindSchema,
  collectedAt: z.string().datetime({ offset: true }),
  teams: z.array(LeagueTeamSchema).min(2),
  lineups: z.array(LineupSchema),
  fixtures: z.array(FixtureSchema).min(1),
  /** Classifica PRIMA di questa giornata: serve per i fatti sulle rimonte. */
  standingsBefore: z.array(StandingRowSchema).default([]),
});
export type LeagueWeekSnapshot = z.infer<typeof LeagueWeekSnapshotSchema>;

/**
 * LE ROSE DELLA LEGA.
 *
 * Vive fuori dalla giornata perche' ha un ciclo di vita diverso: uno snapshot
 * settimanale racconta un turno, le rose durano una stagione. Un admin le
 * carica una volta — dal file che la sua piattaforma gia' produce — e da li'
 * in poi la lega esiste: squadre, ruoli, e il prezzo pagato all'asta.
 *
 * Il prezzo non e' un ornamento: e' la misura dell'ASPETTATIVA, e senza di
 * essa meta' della satira non esiste. Un attaccante da 460 crediti che fa tre
 * punti e' una notizia; lo stesso punteggio da uno pagato 1 non lo e'.
 */
export const RosterPlayerSchema = z.object({
  playerId: z.string().min(1),
  playerName: z.string().min(1),
  role: RoleSchema,
  purchasePrice: z.number().min(0),
});
export type RosterPlayer = z.infer<typeof RosterPlayerSchema>;

export const RosterTeamSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  players: z.array(RosterPlayerSchema).min(1),
});
export type RosterTeam = z.infer<typeof RosterTeamSchema>;

export const LeagueRosterSchema = z.object({
  season: z.string().regex(/^\d{4}-\d{2}$/),
  importedAt: z.string().datetime({ offset: true }),
  /** Da dove sono arrivate: serve a sapere cosa ricontrollare quando non tornano. */
  source: z.enum(['xlsx-rose', 'csv', 'extension', 'synthetic']),
  teams: z.array(RosterTeamSchema).min(2),
});
export type LeagueRoster = z.infer<typeof LeagueRosterSchema>;
