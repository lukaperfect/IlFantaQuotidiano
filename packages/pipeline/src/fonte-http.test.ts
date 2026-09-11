import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '@fantacomics/core';
import {
  FonteHttp, profiloServizioDiProva, generateWorld, withOfficialScores,
  payloadPortaleDiProva,
} from '@fantacomics/ingest';
import { creaFonteGiornata } from './fonte-http.js';
import { InMemoryLeagueStore, type LeagueConfig } from './store.js';

/**
 * Il calendario di Serie A visto dalla fonte HTTP.
 *
 * E' il pezzo da cui discende QUANDO escono i due numeri della settimana, e ha
 * una proprieta' che vale la pena fissare: quando il fornitore non lo da', o lo
 * da' rotto, non deve BLOCCARE le uscite — deve solo smettere di decidere.
 */

const mondo = withOfficialScores(
  generateWorld({ seed: 'calendario', teams: 8, matchday: 5 }),
  DEFAULT_RULESET,
);

/** Partite fisse, non relative ad «adesso»: la verifica non deve dipendere dall'ora. */
const PARTITE = {
  data: {
    partite: [
      { inizio: '2026-09-18T20:45:00+02:00', casa: 'sa-0', trasferta: 'sa-1' },
      { inizio: '2026-09-21T20:45:00+02:00', casa: 'sa-2', trasferta: 'sa-3' },
    ],
  },
};

let corpi: Record<string, unknown> = {};
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const nome = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
    const corpo = corpi[nome];
    if (corpo === undefined) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corpo));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => { await new Promise<void>((r) => { server.close(() => r()); }); });

function fonte() {
  return creaFonteGiornata({
    http: new FonteHttp({ profilo: profiloServizioDiProva(base), attesa: async () => {} }),
    store: new InMemoryLeagueStore(),
    season: '2025-26',
  });
}

const lega = (over: Partial<LeagueConfig> = {}): LeagueConfig => ({
  leagueId: 'lega-1', ownerId: 'acc-1', publicSlug: 'slug-1', relaySecret: null,
  leagueName: 'Lega Uno', ruleset: DEFAULT_RULESET, spice: 2,
  createdAt: '2026-01-01T00:00:00.000Z', lastMatchday: null,
  fonte: { profilo: 'servizio-di-prova', leagueExternalId: 'lega-alfa' },
  ...over,
});

describe('il calendario di Serie A dalla fonte HTTP', () => {
  it('legge gli orari e li porta nella forma canonica', async () => {
    corpi = { partite: PARTITE };
    const cal = await fonte().calendario!(5);
    expect(cal?.matchday).toBe(5);
    expect(cal?.partite.map((p) => p.kickoff)).toEqual([
      '2026-09-18T20:45:00+02:00', '2026-09-21T20:45:00+02:00',
    ]);
    expect(cal?.partite[0]?.homeTeam).toBe('sa-0');
  });

  it('un endpoint assente vale «non lo so», non «non uscire»', async () => {
    /**
     * E' la degradazione che conta: se un calendario mancante bloccasse le
     * uscite, un fornitore che smette di pubblicarlo spegnerebbe il prodotto
     * per tutti senza un errore — il giornale semplicemente non esce piu'.
     */
    corpi = {};
    expect(await fonte().calendario!(5)).toBeNull();
  });

  it('un calendario senza NESSUN orario leggibile vale come assente', async () => {
    /**
     * Restituire un calendario vuoto sarebbe peggio di restituire `null`: chi
     * decide non troverebbe finestre e non uscirebbe piu' niente, che e'
     * esattamente il blocco silenzioso che si vuole evitare.
     */
    corpi = { partite: { data: { partite: [{ casa: 'a', trasferta: 'b' }] } } };
    expect(await fonte().calendario!(5)).toBeNull();

    corpi = { partite: { data: { partite: [] } } };
    expect(await fonte().calendario!(5)).toBeNull();
  });

  it('tiene le partite buone e scarta quelle senza orario', async () => {
    corpi = {
      partite: {
        data: {
          partite: [
            { casa: 'a', trasferta: 'b' },
            { inizio: '2026-09-18T20:45:00+02:00', casa: 'c', trasferta: 'd' },
          ],
        },
      },
    };
    const cal = await fonte().calendario!(5);
    expect(cal?.partite).toHaveLength(1);
  });

  it('lo legge UNA volta per giornata, non una per lega', async () => {
    /**
     * Il calendario e' piano globale come i voti: uguale per tutte le leghe.
     * Chiederlo per lega significa cinquecento richieste identiche.
     */
    let letture = 0;
    corpi = { partite: PARTITE };
    const contatore = createServer((req, res) => {
      letture++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(PARTITE));
    });
    await new Promise<void>((r) => contatore.listen(0, '127.0.0.1', r));
    const addr = contatore.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const f = creaFonteGiornata({
      http: new FonteHttp({ profilo: profiloServizioDiProva(url), attesa: async () => {} }),
      store: new InMemoryLeagueStore(),
      season: '2025-26',
    });
    await f.calendario!(5);
    await f.calendario!(5);
    await f.calendario!(5);
    expect(letture).toBe(1);

    await new Promise<void>((r) => { contatore.close(() => r()); });
  });
});

describe('gli accoppiamenti della lega per la vigilia', () => {
  it('legge solo il calendario di lega, non il pacchetto intero', async () => {
    /**
     * La vigilia esce prima che si giochi: voti e formazioni di quella giornata
     * sono righe vuote. Chiederli sarebbero quattro richieste per lega per
     * ottenere niente, su un tier che ne concede cento al giorno.
     */
    const chiesti: string[] = [];
    const spia = createServer((req, res) => {
      const nome = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
      chiesti.push(nome);
      const corpo = payloadPortaleDiProva(mondo.serieA, mondo.snapshot)[nome];
      if (corpo === undefined) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(corpo));
    });
    await new Promise<void>((r) => spia.listen(0, '127.0.0.1', r));
    const addr = spia.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const f = creaFonteGiornata({
      http: new FonteHttp({ profilo: profiloServizioDiProva(url), attesa: async () => {} }),
      store: new InMemoryLeagueStore(),
      season: '2025-26',
    });
    const sfide = await f.sfide!(lega(), 5);

    expect(chiesti).toEqual(['calendario']);
    expect(sfide.length).toBeGreaterThan(0);
    for (const s of sfide) {
      expect(s.homeTeamId).not.toBe('');
      expect(s.awayTeamId).not.toBe('');
    }

    await new Promise<void>((r) => { spia.close(() => r()); });
  });

  it('una lega non collegata non produce accoppiamenti, e non chiede niente', async () => {
    corpi = { calendario: { data: { incontri: [] } } };
    expect(await fonte().sfide!(lega({ fonte: null }), 5)).toEqual([]);
  });
});
