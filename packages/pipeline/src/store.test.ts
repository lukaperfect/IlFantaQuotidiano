import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DEFAULT_RULESET } from '@fantacomics/core';
import {
  issueMagicLink, consumeMagicLink, peekMagicLink, hashToken, type AuthStore,
} from '@fantacomics/auth';
import { FileLeagueStore, edizioneLeggibile, type LeagueStore } from './store.js';
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
      //
      // Le tabelle si CHIEDONO al catalogo invece di elencarle. Un elenco
      // scritto a mano invecchia alla prima tabella nuova, e il guasto che
      // produce e' pessimo: non un errore, ma dati di un test che
      // ricompaiono in un altro — cioe' una suite che fallisce o passa a
      // seconda dell'ordine. E' successo davvero aggiungendo `league_rosters`.
      const { rows } = await pool.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public'",
      );
      if (rows.length > 0) {
        await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} cascade`);
      }
      return {
        league: new PostgresLeagueStore(pool),
        auth: new PostgresAuthStore(pool),
        cleanup: () => pool.end(),
      };
    },
  },
];

const edizione = (matchday: number, confidence: number) => ({
  meta: {
    leagueId: 'lega-1', leagueName: 'Lega Uno', season: '2025-26', matchday,
    publishedAt: '2026-01-06T08:00:00.000Z', factEngineVersion: '1.0.0',
    promptVersion: '1.0.0', rulesetVersion: 1, models: { template: 'template' },
    selectorSeed: 'x', confidence, degraded: false,
  },
  masthead: { title: 'FantaComics', tagline: '' },
  articles: [{ slot: 'apertura', format: 'f', persona: 'p', blocks: [], factIds: [] }],
  personalCards: [],
}) as never;

const packVuoto = (matchday: number) => ({
  leagueId: 'lega-1', leagueName: 'Lega Uno', matchday, season: '2025-26',
  factEngineVersion: '1.0.0', facts: [], results: [], standings: [],
}) as never;

const lega = (over: Record<string, unknown> = {}) => ({
  leagueId: 'lega-1', ownerId: 'acc-mario', publicSlug: 'slug-lungo-e-casuale',
  relaySecret: null,
  leagueName: 'Lega Uno', ruleset: DEFAULT_RULESET, spice: 2 as const,
  createdAt: '2026-01-01T00:00:00.000Z', lastMatchday: null, ...over,
});

const rosa = (over: Record<string, unknown> = {}) => ({
  season: '2025-26',
  importedAt: '2026-01-01T00:00:00.000Z',
  source: 'xlsx-rose' as const,
  teams: [
    {
      teamId: 'asd-uno', teamName: 'ASD Uno',
      players: [
        { playerId: 'vicario', playerName: 'Vicario', role: 'P' as const, purchasePrice: 94 },
        { playerId: 'bremer', playerName: 'Bremer', role: 'D' as const, purchasePrice: 86 },
      ],
    },
    {
      teamId: 'asd-due', teamName: 'ASD Due',
      players: [
        { playerId: 'maignan', playerName: 'Maignan', role: 'P' as const, purchasePrice: 86 },
      ],
    },
  ],
  ...over,
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

    it('rilegge le rose con ruoli e prezzi d\'asta', async () => {
      expect(await env.league.getRoster('lega-1')).toBeNull();
      await env.league.saveRoster('lega-1', rosa());
      const letta = await env.league.getRoster('lega-1');
      expect(letta?.teams).toHaveLength(2);
      expect(letta?.source).toBe('xlsx-rose');
      expect(letta?.teams[0]?.players[0]).toEqual({
        playerId: 'vicario', playerName: 'Vicario', role: 'P', purchasePrice: 94,
      });
      // Il prezzo e' un numero anche dopo il giro su disco o su jsonb: se
      // tornasse stringa, ogni confronto sull'asta sarebbe silenziosamente
      // lessicografico.
      expect(typeof letta?.teams[0]?.players[0]?.purchasePrice).toBe('number');
    });

    it('ricaricare le rose sostituisce, non accumula', async () => {
      await env.league.saveRoster('lega-1', rosa());
      await env.league.saveRoster('lega-1', rosa({
        importedAt: '2026-02-01T00:00:00.000Z',
        teams: [
          { teamId: 'solo-una', teamName: 'Solo Una', players: [
            { playerId: 'x', playerName: 'X', role: 'A' as const, purchasePrice: 1 },
          ] },
          { teamId: 'solo-due', teamName: 'Solo Due', players: [
            { playerId: 'y', playerName: 'Y', role: 'A' as const, purchasePrice: 2 },
          ] },
        ],
      }));
      const letta = await env.league.getRoster('lega-1');
      expect(letta?.teams.map((t) => t.teamId)).toEqual(['solo-una', 'solo-due']);
      expect(letta?.importedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('le rose non trapassano da una lega all\'altra', async () => {
      await env.league.saveRoster('lega-1', rosa());
      expect(await env.league.getRoster('lega-2')).toBeNull();
    });

    it('rifiuta di salvare rose che non stanno in piedi', async () => {
      await expect(env.league.saveRoster('lega-1', rosa({ teams: [] }))).rejects.toThrow();
      await expect(env.league.saveRoster('lega-1', rosa({ season: 'boh' }))).rejects.toThrow();
      // E dopo un rifiuto non deve essere rimasto niente a meta'.
      expect(await env.league.getRoster('lega-1')).toBeNull();
    });

    it('isola i proprietari', async () => {
      await env.league.saveConfig(lega());
      await env.league.saveConfig(lega({
        leagueId: 'lega-2', ownerId: 'acc-giulia', publicSlug: 'slug-due',
        relaySecret: null, leagueName: 'Di Giulia',
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

    it('la chiave dell’estensione nasce assente, si ruota e si revoca', async () => {
      await env.league.saveConfig(lega());
      // Una credenziale che esiste da prima che serva e' una credenziale in
      // giro senza motivo: nasce nulla e non risolve niente.
      expect(await env.league.getConfigByRelaySecret('')).toBeNull();
      expect(await env.league.getConfigByRelaySecret('chiave-mai-emessa')).toBeNull();

      await env.league.saveConfig(lega({ relaySecret: 'chiave-uno' }));
      expect((await env.league.getConfigByRelaySecret('chiave-uno'))?.leagueId).toBe('lega-1');

      // Ruotare deve TOGLIERE la vecchia: una chiave che continua a funzionare
      // dopo la rotazione rende la rotazione una bugia, esattamente come per
      // lo slug pubblico.
      await env.league.saveConfig(lega({ relaySecret: 'chiave-due' }));
      expect(await env.league.getConfigByRelaySecret('chiave-uno')).toBeNull();
      expect((await env.league.getConfigByRelaySecret('chiave-due'))?.leagueId).toBe('lega-1');

      // E revocare del tutto la spegne senza toccare il resto della lega.
      await env.league.saveConfig(lega({ relaySecret: null }));
      expect(await env.league.getConfigByRelaySecret('chiave-due')).toBeNull();
      expect(await env.league.getConfigForOwner('lega-1', 'acc-mario')).not.toBeNull();
    });

    it('due leghe possono avere entrambe la chiave assente', async () => {
      // Su Postgres l'unicita' e' un indice: se fosse ingenuo, la seconda lega
      // senza chiave violerebbe il vincolo e non si potrebbe creare.
      await env.league.saveConfig(lega());
      await env.league.saveConfig(lega({ leagueId: 'lega-2', publicSlug: 'slug-due' }));
      expect(await env.league.listLeagues('acc-mario')).toHaveLength(2);
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

    it('un’edizione sotto soglia non e’ leggibile finche’ nessuno la approva', async () => {
      /**
       * La confidenza veniva calcolata e poi ignorata da ogni percorso di
       * lettura: un'edizione con riconciliazione fallita finiva nel gruppo
       * esattamente come una buona. Qui la soglia e' una proprieta' della
       * lettura, non un numero stampato accanto al titolo.
       */
      await env.league.saveConfig(lega());
      await env.league.saveEdition('lega-1', edizione(7, 0.42), packVuoto(7));

      const sotto = await env.league.getEdition('lega-1', 7);
      expect(sotto?.approvedAt).toBeNull();
      expect(edizioneLeggibile(sotto!)).toBe(false);

      expect(await env.league.approveEdition('lega-1', 7, '2026-01-06T09:00:00.000Z')).toBe(true);
      const approvata = await env.league.getEdition('lega-1', 7);
      expect(approvata?.approvedAt).toBe('2026-01-06T09:00:00.000Z');
      expect(edizioneLeggibile(approvata!)).toBe(true);
      // Il testo non si tocca: l'approvazione registra un giudizio, non lo cambia.
      expect(approvata?.edition.meta.confidence).toBe(0.42);
    });

    it('sopra soglia non serve il permesso di nessuno', async () => {
      await env.league.saveConfig(lega());
      await env.league.saveEdition('lega-1', edizione(8, 0.91), packVuoto(8));
      const letta = await env.league.getEdition('lega-1', 8);
      expect(letta?.approvedAt).toBeNull();
      expect(edizioneLeggibile(letta!)).toBe(true);
    });

    it('rigenerare la giornata azzera l’approvazione', async () => {
      // Il "va bene" riguardava QUEL giornale: se il testo cambia, va
      // riguardato. Un'approvazione che sopravvive alla rigenerazione
      // pubblicherebbe alla cieca un testo che nessuno ha letto.
      await env.league.saveConfig(lega());
      await env.league.saveEdition('lega-1', edizione(9, 0.4), packVuoto(9));
      await env.league.approveEdition('lega-1', 9, '2026-01-06T09:00:00.000Z');
      expect(edizioneLeggibile((await env.league.getEdition('lega-1', 9))!)).toBe(true);

      await env.league.saveEdition('lega-1', edizione(9, 0.4), packVuoto(9));
      const rifatta = await env.league.getEdition('lega-1', 9);
      expect(rifatta?.approvedAt).toBeNull();
      expect(edizioneLeggibile(rifatta!)).toBe(false);
    });

    it('approvare un’edizione che non c’e’ dice di no', async () => {
      await env.league.saveConfig(lega());
      expect(await env.league.approveEdition('lega-1', 33, '2026-01-06T09:00:00.000Z')).toBe(false);
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

    it('marca il link una volta sola, e lo dice', async () => {
      const issued = await issueMagicLink(env.auth, 'marca@example.com');
      if (!issued.ok) throw new Error('atteso ok');
      const hash = hashToken(issued.token);

      expect(await env.auth.markMagicLinkUsed(hash, 1)).toBe(true);
      // Il secondo tentativo non deve poter dire di aver vinto: e' questo
      // booleano a decidere se una sessione si apre, e se mente due richieste
      // simultanee ne aprono due dallo stesso token.
      expect(await env.auth.markMagicLinkUsed(hash, 2)).toBe(false);
      expect(await env.auth.markMagicLinkUsed('hash-mai-esistito', 3)).toBe(false);
    });

    it('lega il link al browser che l’ha chiesto, e guardarlo non lo consuma', async () => {
      const issued = await issueMagicLink(env.auth, 'nonce@example.com');
      if (!issued.ok) throw new Error('atteso ok');

      expect(await peekMagicLink(env.auth, issued.token, issued.nonce))
        .toEqual({ ok: true, accountId: issued.accountId, stessoBrowser: true });

      // Nonce sbagliato o assente: il link resta valido — aprirlo da un altro
      // dispositivo e' legittimo — ma non e' piu' lo stesso browser, quindi
      // si passa dalla conferma.
      expect(await peekMagicLink(env.auth, issued.token, 'un-altro-nonce'))
        .toMatchObject({ ok: true, stessoBrowser: false });
      expect(await peekMagicLink(env.auth, issued.token, undefined))
        .toMatchObject({ ok: true, stessoBrowser: false });

      // Tre letture e il link e' ancora spendibile: se guardarlo lo bruciasse,
      // la pagina di conferma mostrerebbe un token gia' morto.
      expect((await consumeMagicLink(env.auth, issued.token)).ok).toBe(true);
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
    // Vale anche per il nonce: e' l'altra meta' della credenziale, e in
    // chiaro renderebbe il legame col browser aggirabile da chi legge il file.
    expect(contenuto).not.toContain(issued.nonce);
    expect(contenuto).toContain(hashToken(issued.nonce));
  });

  it('un id di lega con risalite non esce dalla cartella', async () => {
    const store = new FileLeagueStore(root);
    // Da fuori l'id arriva dall'URL di /lega/[id]. La risposta giusta e'
    // "non trovata" — la stessa che riceve chi chiede la lega di un altro.
    expect(await store.getConfigForOwner('../../etc/passwd', 'acc-mario')).toBeNull();
    expect(await store.getConfigForOwner('..', 'acc-mario')).toBeNull();
    expect(await store.getConfigForOwner('', 'acc-mario')).toBeNull();

    // Su ogni altro percorso il fallimento e' rumoroso: un id fuori forma non
    // e' un caso previsto, e passarlo oltre significherebbe scrivere altrove.
    await expect(store.getMemory('../fuga')).rejects.toThrow(/segmento di percorso/);
  });

  it('sopravvive a un riavvio del processo', async () => {
    await new FileLeagueStore(root).saveConfig(lega());
    expect((await new FileLeagueStore(root).getConfigForOwner('lega-1', 'acc-mario'))?.leagueName)
      .toBe('Lega Uno');
  });
});

describe.skipIf(!DB)('PostgresStore — garanzie che il file store non può dare', () => {
  it('tre consumi che leggono tutti il link libero aprono una sola sessione', async () => {
    // Il file store non puo' garantirlo: legge, decide e scrive senza
    // atomicita'. Postgres si', grazie al `used_at is null` nella WHERE —
    // ma solo se il chiamante guarda quante righe ha aggiornato.
    const pool = new pg.Pool({ connectionString: DB });
    try {
      await migrate(pool);
      await pool.query('truncate accounts, magic_links, issue_throttle cascade');
      const auth = new PostgresAuthStore(pool);

      const issued = await issueMagicLink(auth, 'gara@example.com');
      if (!issued.ok) throw new Error('atteso ok');

      /**
       * BARRIERA. Tre `Promise.all` non bastano a produrre la corsa: il pool
       * e il ciclo di eventi finiscono per serializzare le letture, la seconda
       * vede gia' `used_at` valorizzato e il caso interessante non capita mai.
       * Questo test lo sapeva fare male: passava anche azzerando la garanzia,
       * cioe' non verificava cio' che il titolo dice.
       *
       * Qui le tre letture vengono trattenute finche' non sono TUTTE
       * avvenute. E' il caso reale — tre richieste che hanno visto il link
       * libero — e a quel punto l'unico arbitro possibile e' la scrittura.
       */
      let letti = 0;
      let apriLeScritture!: () => void;
      const tutteLette = new Promise<void>((r) => { apriLeScritture = r; });

      const conBarriera: AuthStore = {
        getAccountByEmail: (e) => auth.getAccountByEmail(e),
        getAccount: (id) => auth.getAccount(id),
        createAccount: (a) => auth.createAccount(a),
        saveMagicLink: (l) => auth.saveMagicLink(l),
        getMagicLink: async (h) => {
          const link = await auth.getMagicLink(h);
          if (++letti === 3) apriLeScritture();
          await tutteLette;
          return link;
        },
        markMagicLinkUsed: (h, u) => auth.markMagicLinkUsed(h, u),
        lastIssuedAt: (e) => auth.lastIssuedAt(e),
        recordIssued: (e, a) => auth.recordIssued(e, a),
      };

      const esiti = await Promise.all([
        consumeMagicLink(conBarriera, issued.token),
        consumeMagicLink(conBarriera, issued.token),
        consumeMagicLink(conBarriera, issued.token),
      ]);

      const { rows } = await pool.query(
        'select used_at from magic_links where token_hash = $1', [hashToken(issued.token)],
      );
      expect(rows[0]?.used_at).not.toBeNull();
      expect(esiti.filter((e) => e.ok).length).toBe(1);
      expect(esiti.filter((e) => !e.ok && e.reason === 'gia-usato').length).toBe(2);
    } finally {
      await pool.end();
    }
  });
});
