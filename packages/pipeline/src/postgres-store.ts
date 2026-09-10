import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { Edition, FactPack, LeagueRuleset } from '@fantacomics/core';
import type { Account, AuthStore, MagicLink } from '@fantacomics/auth';
import { emptyMemory, type EditorialMemory } from '@fantacomics/editorial';
import type { HistoricalMatchday, LeagueHistory, RarityCorpus } from '@fantacomics/facts';
import type { LeagueConfig, LeagueStore, PublishedEdition } from './store.js';

/**
 * Implementazione su Postgres delle stesse interfacce servite dai file store.
 *
 * Le due implementazioni condividono la suite di contratto: se una passa e
 * l'altra no, la colpa e' dell'implementazione, non del test. E' questo che
 * rende la migrazione da file a database un cambio di riga nella
 * configurazione invece di un rifacimento.
 */

export type PostgresOptions = {
  connectionString: string;
  /** Prefisso opzionale delle tabelle: utile per isolare i test in parallelo. */
  schema?: string;
};

export async function readSchemaSql(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, 'schema.sql'), 'utf8');
}

/** Applica lo schema. Idempotente: tutte le create sono `if not exists`. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(await readSchemaSql());
}

export class PostgresLeagueStore implements LeagueStore {
  constructor(private readonly pool: pg.Pool) {}

  private toConfig(row: Record<string, unknown>): LeagueConfig {
    return {
      leagueId: row.league_id as string,
      ownerId: row.owner_id as string,
      publicSlug: row.public_slug as string,
      relaySecret: (row.relay_secret as string | null) ?? null,
      leagueName: row.league_name as string,
      ruleset: row.ruleset as LeagueRuleset,
      spice: Number(row.spice) as 1 | 2 | 3,
      createdAt: (row.created_at as Date).toISOString(),
      lastMatchday: row.last_matchday === null ? null : Number(row.last_matchday),
    };
  }

  async listLeagues(ownerId: string): Promise<LeagueConfig[]> {
    const { rows } = await this.pool.query(
      'select * from leagues where owner_id = $1 order by league_name', [ownerId],
    );
    return rows.map((r) => this.toConfig(r));
  }

  async getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null> {
    // Il filtro sul proprietario e' nella query, non in un controllo a valle
    // che si puo' dimenticare.
    const { rows } = await this.pool.query(
      'select * from leagues where league_id = $1 and owner_id = $2', [leagueId, ownerId],
    );
    return rows[0] ? this.toConfig(rows[0]) : null;
  }

  async getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null> {
    const { rows } = await this.pool.query(
      'select * from leagues where public_slug = $1', [publicSlug],
    );
    return rows[0] ? this.toConfig(rows[0]) : null;
  }

  async getConfigByRelaySecret(relaySecret: string): Promise<LeagueConfig | null> {
    // La stringa vuota non e' una chiave: senza questo controllo una lega con
    // `relay_secret` nullo non verrebbe comunque trovata, ma tanto vale non
    // mandare la domanda al database.
    if (relaySecret === '') return null;
    const { rows } = await this.pool.query(
      'select * from leagues where relay_secret = $1', [relaySecret],
    );
    return rows[0] ? this.toConfig(rows[0]) : null;
  }

  async saveConfig(config: LeagueConfig): Promise<void> {
    await this.pool.query(
      `insert into leagues
         (league_id, owner_id, public_slug, relay_secret, league_name, ruleset, spice,
          created_at, last_matchday)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (league_id) do update set
         owner_id = excluded.owner_id,
         public_slug = excluded.public_slug,
         relay_secret = excluded.relay_secret,
         league_name = excluded.league_name,
         ruleset = excluded.ruleset,
         spice = excluded.spice,
         last_matchday = excluded.last_matchday`,
      [
        config.leagueId, config.ownerId, config.publicSlug, config.relaySecret,
        config.leagueName,
        JSON.stringify(config.ruleset), config.spice, config.createdAt, config.lastMatchday,
      ],
    );
  }

  async getEdition(leagueId: string, matchday: number): Promise<PublishedEdition | null> {
    const { rows } = await this.pool.query(
      'select edition, pack from editions where league_id = $1 and matchday = $2',
      [leagueId, matchday],
    );
    const row = rows[0];
    return row ? { edition: row.edition as Edition, pack: row.pack as FactPack } : null;
  }

  async listEditions(leagueId: string): Promise<number[]> {
    const { rows } = await this.pool.query(
      'select matchday from editions where league_id = $1 order by matchday desc', [leagueId],
    );
    return rows.map((r) => Number(r.matchday));
  }

  async saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void> {
    await this.pool.query(
      `insert into editions (league_id, matchday, edition, pack) values ($1,$2,$3,$4)
       on conflict (league_id, matchday) do update set
         edition = excluded.edition, pack = excluded.pack`,
      [leagueId, edition.meta.matchday, JSON.stringify(edition), JSON.stringify(pack)],
    );
    // L'ultima giornata avanza sola: `greatest` evita che una rigenerazione di
    // una giornata vecchia faccia arretrare il puntatore.
    await this.pool.query(
      `update leagues set last_matchday = greatest(coalesce(last_matchday, 0), $2)
       where league_id = $1`,
      [leagueId, edition.meta.matchday],
    );
  }

  async getMemory(leagueId: string): Promise<EditorialMemory> {
    const { rows } = await this.pool.query(
      'select memory from league_state where league_id = $1', [leagueId],
    );
    return (rows[0]?.memory as EditorialMemory) ?? emptyMemory();
  }

  async saveMemory(leagueId: string, memory: EditorialMemory): Promise<void> {
    await this.pool.query(
      `insert into league_state (league_id, memory, history) values ($1,$2,'[]'::jsonb)
       on conflict (league_id) do update set memory = excluded.memory`,
      [leagueId, JSON.stringify(memory)],
    );
  }

  async getHistory(leagueId: string): Promise<LeagueHistory> {
    const { rows } = await this.pool.query(
      'select history from league_state where league_id = $1', [leagueId],
    );
    return { entries: (rows[0]?.history as HistoricalMatchday[]) ?? [] };
  }

  async appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void> {
    const { entries } = await this.getHistory(leagueId);
    // Idempotente: rieseguire la stessa giornata sostituisce, non duplica.
    const next = [...entries.filter((h) => h.matchday !== entry.matchday), entry]
      .sort((a, b) => a.matchday - b.matchday);
    await this.pool.query(
      `insert into league_state (league_id, memory, history) values ($1,'{}'::jsonb,$2)
       on conflict (league_id) do update set history = excluded.history`,
      [leagueId, JSON.stringify(next)],
    );
  }

  async getCorpus(): Promise<RarityCorpus | null> {
    const { rows } = await this.pool.query('select points from corpus_points order by points');
    if (rows.length === 0) return null;
    return { sortedTeamPoints: rows.map((r) => Number(r.points)) };
  }

  async addToCorpus(points: readonly number[]): Promise<void> {
    if (points.length === 0) return;
    await this.pool.query(
      'insert into corpus_points (points) select unnest($1::double precision[])',
      [points],
    );
  }
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: pg.Pool) {}

  private toAccount(row: Record<string, unknown>): Account {
    return {
      accountId: row.account_id as string,
      email: row.email as string,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  async getAccountByEmail(email: string): Promise<Account | null> {
    const { rows } = await this.pool.query('select * from accounts where email = $1', [email]);
    return rows[0] ? this.toAccount(rows[0]) : null;
  }

  async getAccount(accountId: string): Promise<Account | null> {
    const { rows } = await this.pool.query(
      'select * from accounts where account_id = $1', [accountId],
    );
    return rows[0] ? this.toAccount(rows[0]) : null;
  }

  async createAccount(account: Account): Promise<void> {
    // `do nothing` sull'email: due richieste simultanee per lo stesso
    // indirizzo non devono creare due account.
    await this.pool.query(
      `insert into accounts (account_id, email, created_at) values ($1,$2,$3)
       on conflict (email) do nothing`,
      [account.accountId, account.email, account.createdAt],
    );
  }

  async saveMagicLink(link: MagicLink): Promise<void> {
    await this.pool.query(
      `insert into magic_links (token_hash, nonce_hash, account_id, expires_at, used_at)
       values ($1,$2,$3,$4,$5) on conflict (token_hash) do nothing`,
      [link.tokenHash, link.nonceHash, link.accountId, link.expiresAt, link.usedAt],
    );
    // Potatura opportunistica: si tiene un'ora di margine oltre la scadenza,
    // abbastanza per rispondere "gia-usato" invece di "sconosciuto".
    await this.pool.query('delete from magic_links where expires_at < $1', [Date.now() - 3_600_000]);
  }

  async getMagicLink(tokenHash: string): Promise<MagicLink | null> {
    const { rows } = await this.pool.query(
      'select * from magic_links where token_hash = $1', [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tokenHash: row.token_hash as string,
      nonceHash: (row.nonce_hash as string | null) ?? null,
      accountId: row.account_id as string,
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
    };
  }

  async markMagicLinkUsed(tokenHash: string, usedAt: number): Promise<boolean> {
    // `used_at is null` nella WHERE: se due richieste corrono, solo una riga
    // viene aggiornata. Ma la condizione da sola non basta — se il chiamante
    // non guarda QUANTE righe ha toccato, entrambe le richieste credono di
    // aver vinto e aprono una sessione. E' `rowCount` a rendere vera la
    // garanzia; senza, il monouso resta deciso da una lettura precedente.
    const { rowCount } = await this.pool.query(
      'update magic_links set used_at = $2 where token_hash = $1 and used_at is null',
      [tokenHash, usedAt],
    );
    return (rowCount ?? 0) === 1;
  }

  async lastIssuedAt(email: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      'select issued_at from issue_throttle where email = $1', [email],
    );
    return rows[0] ? Number(rows[0].issued_at) : null;
  }

  async recordIssued(email: string, at: number): Promise<void> {
    await this.pool.query(
      `insert into issue_throttle (email, issued_at) values ($1,$2)
       on conflict (email) do update set issued_at = excluded.issued_at`,
      [email, at],
    );
  }
}
