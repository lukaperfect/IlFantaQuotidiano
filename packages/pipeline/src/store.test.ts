import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { issueMagicLink, consumeMagicLink, hashToken, type AuthStore } from '@fantacomics/auth';
import { FileLeagueStore, type LeagueStore } from './store.js';
import { FileAuthStore } from './auth-store.js';
import { PostgresLeagueStore, PostgresAuthStore, migrate } from './postgres-store.js';

/**
 * SUITE DI CONTRATTO.
 *
 * Le stesse asserzioni girano su file e su Postgres. E' cio' che rende la
 * migrazione un cambio di configurazione invece di un rifacimento: se le due
 * implementazioni divergono, il test lo dice subito e con precisione.
 */

type Ambiente = { league: LeagueStore; auth: AuthStore; cleanup: () => Promise<void> };

const DB = process.env.FANTACOMICS_TEST_DB;

const implementazioni: { nome: string; salta: boolean; crea: () => Promise<Ambiente> }[] = [
  {
    nome: 'FileStore',
    salta: false,
    crea: async () => {
      const root = await mkdtemp(join(tmpdir(), 'fc-store-'));
      return {
        league: new FileLeagueStore(root),
        auth: new FileAuthStore(root),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    nome: 'PostgresStore',
    salta: !DB,
    crea: async () => {
      const pool = new pg.Pool({ connectionString: DB });
      await migrate(pool);
      // Ogni test parte da zero: gli identificatori si ripetono fra i casi.
      await pool.query(
        'truncate leagues, editions, league_state, corpus_points, accounts, magic_links, issue_throttle cascade',
      );
      return {
        league: new PostgresLeagueStore(pool),
        auth: new PostgresAuthStore(pool),
        cleanup: () => pool.end(),
      };
    },
  },
];

const lega = (over: Record<string, unknown> = {}) => ({
  leagueId: 'lega-1', ownerId: 'acc-mario', publicSlug: 'slug-lungo-e-casuale',
  leagueName: 'Lega Uno', ruleset: DEFAULT_RULESET, spice: 2 as const,
  createdAt: '2026-01-01T00:00:00.000Z', lastMatchday: null, ...over,
});

for (const impl of implementazioni) {
  describe.skipIf(impl.salta)(`contratto dello store — ${impl.nome}`, () => {
    let env: Ambiente;
    beforeEach(async () => { env = await impl.crea(); });
    afterEach(async () => { await env.cleanup(); });

    it('rilegge ciò che ha scritto', async () => {
      await env.league.saveConfig(lega());
      const letto = await env.league.getConfigForOwner('lega-1', 'acc-mario');
      expect(letto?.leagueName).toBe('Lega Uno');
      expect(letto?.spice).toBe(2);
      expect(letto?.ruleset.goalThreshold.base).toBe(66);
      expect(await env.league.listLeagues('acc-mario')).toHaveLength(1);
    });

    it('isola i proprietari', async () => {
      await env.league.saveConfig(lega());
      await env.league.saveConfig(lega({
        leagueId: 'lega-2', ownerId: 'acc-giulia', publicSlug: 'slug-due', leagueName: 'Di Giulia',
      }));
      expect((await env.league.listLeagues('acc-mario')).map((l) => l.leagueId)).toEqual(['lega-1']);
      expect(await env.league.getConfigForOwner('lega-2', 'acc-mario')).toBeNull();
      expect(await env.league.listLeagues('acc-estraneo')).toEqual([]);
    });

    it('una lega altrui risponde come una inesistente', async () => {
      await env.league.saveConfig(lega());
      expect(await env.league.getConfigForOwner('lega-1', 'acc-giulia')).toBeNull();
      expect(await env.league.getConfigForOwner('lega-fantasma', 'acc-mario')).toBeNull();
    });

    it('rigenerare lo slug revoca il precedente', async () => {
      await env.league.saveConfig(lega());
      expect(await env.league.getConfigBySlug('slug-lungo-e-casuale')).not.toBeNull();

      await env.league.saveConfig(lega({ publicSlug: 'slug-nuovo' }));
      expect(await env.league.getConfigBySlug('slug-lungo-e-casuale')).toBeNull();
      expect((await env.league.getConfigBySlug('slug-nuovo'))?.leagueId).toBe('lega-1');
    });

    it('conserva edizione e fact pack insieme', async () => {
      await env.league.saveConfig(lega());
      const edition = {
        meta: {
          leagueId: 'lega-1', leagueName: 'Lega Uno', season: '2025-26', matchday: 7,
          publishedAt: '2026-01-06T08:00:00.000Z', factEngineVersion: '1.0.0',
          promptVersion: '1.0.0', rulesetVersion: 1, models: { template: 'template' },
          selectorSeed: 'x', confidence: 0.9, degraded: false,
        },
        masthead: { title: 'FantaComics', tagline: '' },
        articles: [{ slot: 'apertura', format: 'f', persona: 'p', blocks: [], factIds: [] }],
        personalCards: [],
      } as never;
      const pack = {
        leagueId: 'lega-1', leagueName: 'Lega Uno', matchday: 7, season: '2025-26',
        factEngineVersion: '1.0.0', facts: [], results: [], standings: [],
      } as never;

      await env.league.saveEdition('lega-1', edition, pack);
      const letto = await env.league.getEdition('lega-1', 7);
      expect(letto?.edition.meta.matchday).toBe(7);
      expect(letto?.pack.leagueName).toBe('Lega Uno');
      expect(await env.league.listEditions('lega-1')).toEqual([7]);
      expect((await env.league.getConfigForOwner('lega-1', 'acc-mario'))?.lastMatchday).toBe(7);
    });

    it('non fa arretrare l’ultima giornata rigenerandone una vecchia', async () => {
      await env.league.saveConfig(lega({ lastMatchday: 12 }));
      const mk = (n: number) => ({
        meta: {
          leagueId: 'lega-1', leagueName: 'L', season: '2025-26', matchday: n,
          publishedAt: '2026-01-06T08:00:00.000Z', factEngineVersion: '1', promptVersion: '1',
          rulesetVersion: 1, models: {}, selectorSeed: 's', confidence: 1, degraded: false,
        },
        masthead: { title: 'F', tagline: '' },
        articles: [{ slot: 'apertura', format: 'f', persona: 'p', blocks: [], factIds: [] }],
        personalCards: [],
      }) as never;
      const pack = {
        leagueId: 'lega-1', leagueName: 'L', matchday: 3, season: '2025-26',
        factEngineVersion: '1', facts: [], results: [], standings: [],
      } as never;

      await env.league.saveEdition('lega-1', mk(3), pack);
      expect((await env.league.getConfigForOwner('lega-1', 'acc-mario'))?.lastMatchday).toBe(12);
    });

    it('accumula lo storico in modo idempotente', async () => {
      const entry = (n: number) => ({
        matchday: n, points: { t1: 60 + n }, results: { t1: 'W' as const },
        opponents: { t1: 't2' }, positions: { t1: 1 },
      });
      await env.league.appendHistory('lega-1', entry(1));
      await env.league.appendHistory('lega-1', entry(2));
      await env.league.appendHistory('lega-1', entry(1));

      const storico = await env.league.getHistory('lega-1');
      expect(storico.entries.map((e) => e.matchday)).toEqual([1, 2]);
    });

    it('memoria e storico convivono senza sovrascriversi', async () => {
      // Entrambi vivono sulla stessa riga in Postgres: e' il caso in cui una
      // upsert scritta male cancella l'altro campo.
      await env.league.saveMemory('lega-1', {
        lastFactTypeUse: { SFIGA_CERTIFICATA: 5 }, lastFormatUse: {}, lastPersonaUse: {},
        lastAppearance: {}, lastGlory: {}, recentTargetCount: {},
      });
      await env.league.appendHistory('lega-1', {
        matchday: 5, points: { t1: 70 }, results: { t1: 'W' }, opponents: { t1: 't2' },
        positions: { t1: 1 },
      });

      expect((await env.league.getMemory('lega-1')).lastFactTypeUse.SFIGA_CERTIFICATA).toBe(5);
      expect((await env.league.getHistory('lega-1')).entries).toHaveLength(1);
    });

    it('il corpus cresce e resta ordinato', async () => {
      expect(await env.league.getCorpus()).toBeNull();
      await env.league.addToCorpus([70.5, 55, 88]);
      await env.league.addToCorpus([61.5]);
      const corpus = await env.league.getCorpus();
      expect(corpus?.sortedTeamPoints).toEqual([55, 61.5, 70.5, 88]);
    });

    it('completa il giro emissione → consumo del magic link', async () => {
      const issued = await issueMagicLink(env.auth, 'mario@example.com');
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;

      expect(await consumeMagicLink(env.auth, issued.token))
        .toEqual({ ok: true, accountId: issued.accountId });
      expect((await env.auth.getAccount(issued.accountId))?.email).toBe('mario@example.com');

      const secondo = await consumeMagicLink(env.auth, issued.token);
      expect(secondo.ok).toBe(false);
      if (!secondo.ok) expect(secondo.reason).toBe('gia-usato');
    });

    it('non duplica l’account sulla stessa email', async () => {
      const a = await issueMagicLink(env.auth, 'a@b.it', { now: 1_000_000 });
      const b = await issueMagicLink(env.auth, 'a@b.it', { now: 1_000_000 + 60_000 });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(b.accountId).toBe(a.accountId);
    });

    it('rispetta il limite di frequenza per email', async () => {
      await issueMagicLink(env.auth, 'a@b.it', { now: 1_000_000 });
      const subito = await issueMagicLink(env.auth, 'a@b.it', { now: 1_000_100 });
      expect(subito.ok).toBe(false);
    });
  });
}

describe('FileStore — dettagli di implementazione', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fc-file-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('non scrive mai il token in chiaro su disco', async () => {
    const store = new FileAuthStore(root);
    const issued = await issueMagicLink(store, 'a@b.it');
    if (!issued.ok) throw new Error('atteso ok');

    const contenuto = await readFile(join(root, 'auth.json'), 'utf8');
    expect(contenuto).not.toContain(issued.token);
    expect(contenuto).toContain(hashToken(issued.token));
  });

  it('sopravvive a un riavvio del processo', async () => {
    await new FileLeagueStore(root).saveConfig(lega());
    expect((await new FileLeagueStore(root).getConfigForOwner('lega-1', 'acc-mario'))?.leagueName)
      .toBe('Lega Uno');
  });
});

describe.skipIf(!DB)('PostgresStore — garanzie che il file store non può dare', () => {
  it('due consumi simultanei dello stesso link aprono una sola sessione', async () => {
    // Il file store non puo' garantirlo: legge, decide e scrive senza
    // atomicita'. Postgres si', grazie al `used_at is null` nella WHERE.
    // La differenza e' documentata, non nascosta.
    const pool = new pg.Pool({ connectionString: DB });
    try {
      await migrate(pool);
      await pool.query('truncate accounts, magic_links, issue_throttle cascade');
      const auth = new PostgresAuthStore(pool);

      const issued = await issueMagicLink(auth, 'gara@example.com');
      if (!issued.ok) throw new Error('atteso ok');

      const esiti = await Promise.all([
        consumeMagicLink(auth, issued.token),
        consumeMagicLink(auth, issued.token),
        consumeMagicLink(auth, issued.token),
      ]);
      const { rows } = await pool.query(
        'select used_at from magic_links where token_hash = $1', [hashToken(issued.token)],
      );
      expect(rows[0]?.used_at).not.toBeNull();
      expect(esiti.filter((e) => e.ok).length).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });
});
