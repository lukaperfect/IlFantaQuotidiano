import pg from 'pg';
import {
  FileLeagueStore, FileAuthStore,
  PostgresLeagueStore, PostgresAuthStore,
  type LeagueStore,
} from '@fantacomics/pipeline';
import type { AuthStore } from '@fantacomics/auth';

/**
 * Scelta della persistenza.
 *
 * Con `DATABASE_URL` si va su Postgres, altrimenti su file. Le due
 * implementazioni condividono una suite di contratto, quindi il passaggio e'
 * una variabile d'ambiente e non un rifacimento — che era esattamente lo
 * scopo di tenere lo store dietro un'interfaccia.
 */

const url = process.env.DATABASE_URL;

/** Il pool e' condiviso: aprirne uno per richiesta esaurisce le connessioni. */
export const pool: pg.Pool | null = url
  ? new pg.Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    })
  : null;

const root = process.env.FANTACOMICS_DATA ?? '.data';

export const store: LeagueStore = pool
  ? new PostgresLeagueStore(pool)
  : new FileLeagueStore(root);

export const authStore: AuthStore = pool
  ? new PostgresAuthStore(pool)
  : new FileAuthStore(root);

export const usingPostgres = pool !== null;
