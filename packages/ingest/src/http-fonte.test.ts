import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdapterError } from './adapter.js';
import {
  FonteHttp, importaDaHttp, riempi, ProfiloFonteSchema, type ProfiloFonte,
} from './collectors/http-fonte.js';
import { importFromRelay } from './collectors/relay-import.js';
import { PROFILO_PROVA } from './profiles.js';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { generateWorld, withOfficialScores } from './synthetic.js';
import { payloadPortaleDiProva } from './synthetic-portal.js';

/**
 * Il mondo di prova e i payload che un servizio servirebbe. Sono gli STESSI
 * che il portale finto serve all'estensione: e' cio' che permette di
 * verificare che le due sorgenti convergano davvero invece di somigliarsi.
 */
const mondo = withOfficialScores(
  generateWorld({ seed: 'http', teams: 8, matchday: 5 }),
  DEFAULT_RULESET,
);
const PAYLOAD = payloadPortaleDiProva(mondo.serieA, mondo.snapshot);

/** Il profilo HTTP riusa le mappature del profilo dell'estensione, tali e quali. */
function profilo(baseUrl: string, over: Partial<ProfiloFonte> = {}): ProfiloFonte {
  return ProfiloFonteSchema.parse({
    fonte: 'servizio-di-prova',
    version: 1,
    baseUrl,
    endpoints: {
      voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' },
      formazioni: { percorso: '/formazioni?lega={leagueExternalId}&g={matchday}', piano: 'lega' },
      calendario: { percorso: '/calendario?lega={leagueExternalId}&g={matchday}', piano: 'lega' },
      rose: { percorso: '/rose?lega={leagueExternalId}', piano: 'lega', facoltativo: true },
      classifica: { percorso: '/classifica?lega={leagueExternalId}', piano: 'lega', facoltativo: true },
    },
    mappings: PROFILO_PROVA.mappings,
    ...over,
  });
}

const CTX = { matchday: 5, season: '2025-26', leagueExternalId: 'lega-alfa' };

/* ------------------------------------------------------------------ */
/* Un servizio finto, con la possibilita' di farlo comportare male.     */
/* ------------------------------------------------------------------ */

type Comportamento = {
  /** Quante volte rispondere con questo stato prima di tornare normale. */
  guasti?: { quante: number; stato: number };
  /** Risponde con un corpo che non e' JSON, ma con stato 200. */
  htmlInvece?: boolean;
  /** Attiva ETag e 304. */
  etag?: boolean;
  /** Ritarda la risposta di tanti ms: serve a provare il timeout. */
  ritardoMs?: number;
  /** Endpoint che risponde 404. */
  assente?: string;
};

let server: Server;
let base = '';
let comportamento: Comportamento = {};
const contatore = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const nome = url.pathname.slice(1);
    contatore.set(nome, (contatore.get(nome) ?? 0) + 1);

    const rispondi = () => {
      if (comportamento.assente === nome) { res.writeHead(404); res.end('non trovato'); return; }

      const guasti = comportamento.guasti;
      if (guasti && guasti.quante > 0) {
        guasti.quante--;
        res.writeHead(guasti.stato, { 'content-type': 'application/json' });
        res.end('{"errore":"in affanno"}');
        return;
      }

      if (comportamento.htmlInvece) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body>Service Unavailable</body></html>');
        return;
      }

      const corpo = PAYLOAD[nome];
      if (corpo === undefined) { res.writeHead(404); res.end('non trovato'); return; }

      if (comportamento.etag) {
        const tag = `"v1-${nome}"`;
        if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', etag: tag });
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify(corpo));
    };

    if (comportamento.ritardoMs) setTimeout(rispondi, comportamento.ritardoMs);
    else rispondi();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => { server.close(() => r()); });
});

function azzera(c: Comportamento = {}) {
  comportamento = c;
  contatore.clear();
}

/** Attesa finta: i test non devono dormire per davvero. */
const subito = async () => {};

/* ------------------------------------------------------------------ */

describe('fonte HTTP', () => {
  it('scarica tutti i payload e li mappa nello snapshot canonico', async () => {
    azzera();
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    const payloads = await fonte.payloadCompleti(CTX);
    expect(Object.keys(payloads).sort()).toEqual(
      ['calendario', 'classifica', 'formazioni', 'rose', 'voti'],
    );

    const { snapshot, serieA } = importaDaHttp(payloads, fonte, {
      leagueId: 'lega-1', leagueName: 'Lega Uno', season: '2025-26', matchday: 5,
    });
    expect(snapshot.teams).toHaveLength(8);
    expect(snapshot.lineups).toHaveLength(8);
    expect(serieA.players.length).toBeGreaterThan(0);
  });

  /**
   * LA CONVERGENZA, DIMOSTRATA.
   *
   * Gli stessi payload, una volta intercettati dall'estensione e una volta
   * scaricati via HTTP, devono dare lo stesso identico snapshot. E' la
   * proprieta' su cui poggia tutta l'architettura: se le due strade
   * divergessero, lo stesso turno produrrebbe due giornali diversi a seconda di
   * come sono entrati i dati.
   */
  it('da lo stesso snapshot dell\'estensione a parita\' di payload', async () => {
    azzera();
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    const payloads = await fonte.payloadCompleti(CTX);

    const viaHttp = importaDaHttp(payloads, fonte, {
      leagueId: 'lega-1', leagueName: 'Lega Uno', season: '2025-26', matchday: 5,
    });
    const viaEstensione = importFromRelay(
      {
        clientVersion: '1.0.0', platform: 'portale-di-prova', leagueExternalId: 'lega-1',
        matchday: 5, season: '2025-26', capturedAt: '2026-01-01T00:00:00.000Z',
        payloads: PAYLOAD,
      },
      PROFILO_PROVA,
      { leagueId: 'lega-1', leagueName: 'Lega Uno', season: '2025-26' },
    );

    // `collectedAt` e `collector` differiscono di proposito — dicono da dove
    // sono arrivati — quindi si confronta tutto il resto.
    const { collectedAt: _a, collector: _b, ...http } = viaHttp.snapshot;
    const { collectedAt: _c, collector: _d, ...est } = viaEstensione.snapshot;
    expect(http).toEqual(est);
    expect(viaHttp.serieA.players).toEqual(viaEstensione.serieA.players);
  });

  /**
   * L'INVERSIONE ARCHITETTURALE, RESA ESECUTIVA.
   *
   * Dieci leghe nella stessa giornata devono produrre UNA lettura del piano
   * globale, non dieci. E' la scelta che fa crollare il volume di richieste, e
   * su un'API a consumo e' la differenza fra un costo e un problema.
   */
  it('legge il piano globale una volta per giornata, non una per lega', async () => {
    azzera();
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    for (let i = 0; i < 10; i++) {
      await fonte.payloadCompleti({ ...CTX, leagueExternalId: `lega-${i}` });
    }
    expect(contatore.get('voti')).toBe(1);
    // Il piano di lega invece cambia per definizione: dieci leghe, dieci letture.
    expect(contatore.get('formazioni')).toBe(10);
    expect(fonte.stato.riusi).toBe(9);
  });

  it('una giornata diversa e\' una lettura diversa', async () => {
    azzera();
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    await fonte.payload('globale', { ...CTX, matchday: 5 });
    await fonte.payload('globale', { ...CTX, matchday: 6 });
    expect(contatore.get('voti')).toBe(2);
  });

  it('invalidare la cache fa rileggere davvero', async () => {
    azzera();
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    await fonte.payload('globale', CTX);
    await fonte.payload('globale', CTX);
    expect(contatore.get('voti')).toBe(1);
    fonte.invalida(5);
    await fonte.payload('globale', CTX);
    expect(contatore.get('voti')).toBe(2);
  });
});

describe('quando il servizio si comporta male', () => {
  it('ritenta sui guasti passeggeri e poi ce la fa', async () => {
    azzera({ guasti: { quante: 2, stato: 503 } });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 3 });
    const payloads = await fonte.payload('globale', CTX);
    expect(payloads.voti).toBeDefined();
    expect(contatore.get('voti')).toBe(3);
  });

  it('si arrende dopo i tentativi previsti, dicendo chi non rispondeva', async () => {
    azzera({ guasti: { quante: 99, stato: 503 } });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 2 });
    await expect(fonte.payload('globale', CTX)).rejects.toThrow(/servizio-di-prova/);
    expect(contatore.get('voti')).toBe(2);
  });

  /**
   * Una credenziale rifiutata NON si ritenta. Ritentare in eterno su una
   * chiave scaduta significa non accorgersi mai che e' scaduta — e nel
   * frattempo bruciare quota su richieste che non possono funzionare.
   */
  it('non ritenta su credenziali rifiutate', async () => {
    azzera({ guasti: { quante: 99, stato: 401 } });
    const fonte = new FonteHttp({
      profilo: profilo(base, { auth: { tipo: 'bearer' } }), chiave: 'x',
      attesa: subito, tentativi: 5,
    });
    await expect(fonte.payload('globale', CTX)).rejects.toMatchObject({ kind: 'auth' });
    expect(contatore.get('voti')).toBe(1);
  });

  it('riconosce il limite di frequenza come cosa passeggera', async () => {
    azzera({ guasti: { quante: 1, stato: 429 } });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 2 });
    await fonte.payload('globale', CTX);
    expect(contatore.get('voti')).toBe(2);
  });

  /**
   * Il caso piu' frequente in assoluto, e quello che fa perdere piu' tempo se
   * il messaggio e' generico: una pagina di errore HTML servita con stato 200.
   */
  it('spiega quando la risposta non e\' JSON pur essendo 200', async () => {
    azzera({ htmlInvece: true });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 1 });
    await expect(fonte.payload('globale', CTX)).rejects.toThrow(/non e' JSON/);
  });

  it('un endpoint facoltativo assente non ferma la giornata', async () => {
    azzera({ assente: 'rose' });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 1 });
    const payloads = await fonte.payloadCompleti(CTX);
    expect(payloads.rose).toBeUndefined();
    expect(payloads.formazioni).toBeDefined();
  });

  it('un endpoint obbligatorio assente invece la ferma', async () => {
    azzera({ assente: 'formazioni' });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito, tentativi: 1 });
    await expect(fonte.payloadCompleti(CTX)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('un servizio che non risponde in tempo e\' un guasto passeggero', async () => {
    azzera({ ritardoMs: 300 });
    const fonte = new FonteHttp({
      profilo: profilo(base), attesa: subito, tentativi: 1, timeoutMs: 50,
    });
    await expect(fonte.payload('globale', CTX)).rejects.toMatchObject({
      kind: 'network', retryable: true,
    });
  });

  it('il messaggio di un guasto di rete non riporta l\'URL', async () => {
    // Se la chiave sta in query string, l'URL la contiene: ripeterlo nel
    // messaggio la scriverebbe in ogni log.
    azzera({ ritardoMs: 300 });
    const fonte = new FonteHttp({
      profilo: profilo(base, { auth: { tipo: 'query', nome: 'apiKey' } }),
      chiave: 'segretissima', attesa: subito, tentativi: 1, timeoutMs: 50,
    });
    const errore = await fonte.payload('globale', CTX).catch((e: Error) => e);
    expect(errore).toBeInstanceOf(AdapterError);
    expect((errore as Error).message).not.toContain('segretissima');
    expect((errore as Error).message).not.toContain('http://');
  });

  it('rifiuta di partire se il profilo vuole una chiave e non c\'e\'', () => {
    expect(() => new FonteHttp({ profilo: profilo(base, { auth: { tipo: 'bearer' } }) }))
      .toThrow(/credenziale/);
  });
});

describe('ETag', () => {
  it('una 304 vale come lettura, e dice che non e\' cambiato niente', async () => {
    azzera({ etag: true });
    const fonte = new FonteHttp({ profilo: profilo(base), attesa: subito });
    const primo = await fonte.payload('globale', CTX);
    fonte.invalida(5);
    const secondo = await fonte.payload('globale', CTX);
    expect(secondo).toEqual(primo);
    expect(contatore.get('voti')).toBe(2);
    expect(fonte.stato.nonModificate).toBe(1);
  });
});

describe('i segnaposto nell\'URL', () => {
  it('riempie giornata, stagione e lega', () => {
    expect(riempi('/g/{matchday}/{season}/{leagueExternalId}', CTX))
      .toBe('/g/5/2025-26/lega-alfa');
  });

  /**
   * Un id di lega arriva dalla configurazione di un utente. Interpolarlo
   * grezzo gli lascerebbe aggiungere parametri alla NOSTRA richiesta
   * autenticata: e' una iniezione nell'URL.
   */
  it('codifica i valori invece di incollarli', () => {
    const cattivo = { ...CTX, leagueExternalId: 'x&apiKey=rubata&y=../../admin' };
    const url = riempi('/formazioni?lega={leagueExternalId}', cattivo);
    expect(url).not.toContain('&apiKey=');
    expect(url).not.toContain('../');
    expect(url).toContain('%26apiKey');
  });

  it('non inventa segnaposto che non conosce', () => {
    expect(() => riempi('/x/{sconosciuto}', CTX)).toThrow(/sconosciuto/);
  });
});
