import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdapterError } from './adapter.js';
import {
  FonteHttp, importaDaHttp, riempi, ProfiloFonteSchema, type ProfiloFonte,
} from './collectors/http-fonte.js';
import { importFromRelay } from './collectors/relay-import.js';
import { jsonDentroHtml, scegliBlocco } from './collectors/html-json.js';
import { applyMapping } from './collectors/extension-relay.js';
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
    // Il servizio finto di questo file e' il nostro: niente robots.txt da
    // chiedere, e nessuna attesa da rispettare fra una prova e l'altra.
    rispettaRobots: false,
    attesaMinimaMs: 0,
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

/* ------------------------------------------------------------------ *
 * Come ci si presenta a un sito che non ci ha invitato
 * ------------------------------------------------------------------ */

describe('identificazione e robots.txt', () => {
  /** Un servizio finto che registra cosa gli viene chiesto e con che nome. */
  function servizio(robotsTxt: string | null) {
    const chiamate: { percorso: string; agente: string }[] = [];
    const impl = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(u));
      const h = new Headers(init?.headers as Record<string, string>);
      chiamate.push({ percorso: url.pathname, agente: h.get('user-agent') ?? '' });
      if (url.pathname === '/robots.txt') {
        return robotsTxt === null
          ? new Response('no', { status: 404 })
          : new Response(robotsTxt, { status: 200 });
      }
      return new Response(JSON.stringify(PAYLOAD.voti), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, chiamate };
  }

  const conIdentita = (baseUrl: string, over: Record<string, unknown> = {}) => ProfiloFonteSchema.parse({
    fonte: 'sito-vero',
    version: 1,
    baseUrl,
    identificazione: {
      prodotto: 'FantaComics', versione: '1.0', contatto: 'https://fantacomics.it/bot',
    },
    attesaMinimaMs: 0,
    endpoints: { voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' } },
    mappings: { voti: PROFILO_PROVA.mappings.voti },
    ...over,
  });

  it('si presenta con prodotto, versione e un contatto', async () => {
    /**
     * Uno scraper anonimo e' quello che si prende il ban dell'IP; uno che dice
     * chi e' e lascia un recapito si prende, al massimo, una mail. La
     * differenza costa un header.
     */
    const { impl, chiamate } = servizio(null);
    const fonte = new FonteHttp({ profilo: conIdentita('http://sito.test'), attesa: subito, fetchImpl: impl });
    await fonte.payload('globale', CTX);

    const suVoti = chiamate.find((c) => c.percorso === '/voti');
    expect(suVoti?.agente).toBe('FantaComics/1.0 (+https://fantacomics.it/bot)');
  });

  it('chiede il robots.txt PRIMA di chiedere i dati', async () => {
    const { impl, chiamate } = servizio('User-agent: *\nDisallow:\n');
    const fonte = new FonteHttp({ profilo: conIdentita('http://sito.test'), attesa: subito, fetchImpl: impl });
    await fonte.payload('globale', CTX);

    expect(chiamate[0]?.percorso).toBe('/robots.txt');
    expect(chiamate[1]?.percorso).toBe('/voti');
  });

  it('un percorso vietato NON viene chiesto affatto', async () => {
    /**
     * Il controllo sta prima della richiesta, non dopo: dopo sarebbe inutile —
     * la richiesta vietata l'avremmo gia' fatta, e nei loro log ci sarebbe
     * comunque.
     */
    const { impl, chiamate } = servizio('User-agent: *\nDisallow: /voti\n');
    const fonte = new FonteHttp({ profilo: conIdentita('http://sito.test'), attesa: subito, fetchImpl: impl });

    await expect(fonte.payload('globale', CTX)).rejects.toThrow(/robots\.txt/i);
    expect(chiamate.some((c) => c.percorso === '/voti')).toBe(false);
  });

  it('e il messaggio dice cosa fare, non solo che e\' andata male', async () => {
    const { impl } = servizio('User-agent: *\nDisallow: /voti\n');
    const fonte = new FonteHttp({ profilo: conIdentita('http://sito.test'), attesa: subito, fetchImpl: impl });
    try {
      await fonte.payload('globale', CTX);
      expect.unreachable('doveva rifiutare');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('accordo');
      expect(m).toContain('rispettaRobots');
    }
  });

  it('il robots.txt si legge UNA volta per host, non a ogni richiesta', async () => {
    const { impl, chiamate } = servizio('User-agent: *\nDisallow:\n');
    const fonte = new FonteHttp({
      profilo: conIdentita('http://sito.test', {
        endpoints: {
          voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' },
          altro: { percorso: '/altro?giornata={matchday}', piano: 'globale' },
        },
        mappings: { voti: PROFILO_PROVA.mappings.voti },
      }),
      attesa: subito,
      fetchImpl: impl,
    });
    await fonte.payload('globale', CTX);
    await fonte.payload('globale', { ...CTX, matchday: 6 });

    expect(chiamate.filter((c) => c.percorso === '/robots.txt')).toHaveLength(1);
  });

  it('un profilo che dichiara di NON rispettarlo non lo chiede nemmeno', async () => {
    const { impl, chiamate } = servizio('User-agent: *\nDisallow: /voti\n');
    const fonte = new FonteHttp({
      profilo: conIdentita('http://sito.test', { rispettaRobots: false }),
      attesa: subito,
      fetchImpl: impl,
    });
    await fonte.payload('globale', CTX);

    expect(chiamate.some((c) => c.percorso === '/robots.txt')).toBe(false);
    expect(chiamate.some((c) => c.percorso === '/voti')).toBe(true);
  });

  it('il Crawl-delay che chiedono vince sulla nostra attesa minima', async () => {
    const attese: number[] = [];
    const { impl } = servizio('User-agent: *\nDisallow:\nCrawl-delay: 3\n');
    const fonte = new FonteHttp({
      profilo: conIdentita('http://sito.test', {
        attesaMinimaMs: 100,
        endpoints: {
          voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' },
          altro: { percorso: '/altro?giornata={matchday}', piano: 'globale' },
        },
        mappings: { voti: PROFILO_PROVA.mappings.voti },
      }),
      // L'attesa si registra invece di dormire davvero: un test che dorme tre
      // secondi e' un test che nessuno esegue volentieri.
      attesa: async (ms: number) => { attese.push(ms); },
      fetchImpl: impl,
    });
    await fonte.payload('globale', CTX);

    // La prima richiesta non aspetta; la seconda sì, e per i 3 secondi loro.
    expect(attese.some((ms) => ms > 2000)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Leggere un SITO invece di un'API
 * ------------------------------------------------------------------ */

describe('i voti presi da una pagina, una volta per tutti', () => {
  /** Una pagina come la servirebbe un sito vero: dati dentro __NEXT_DATA__. */
  const pagina = (voti: unknown) => `<!doctype html><html><head><title>Voti</title></head>
<body><h1>Voti</h1>
<script>var contatore = 0;</script>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { voti } },
  })}</script>
<script type="application/ld+json">{"@type":"WebPage"}</script>
</body></html>`;

  const VOTI = [
    { id: 'p1', nome: 'Martinez L.', ruolo: 'A', squadra: 'Inter', stats: { voto: 7.5, minuti: 90 } },
    { id: 'p2', nome: 'Sommer', ruolo: 'P', squadra: 'Inter', stats: { voto: 6, minuti: 90 } },
  ];

  function sito() {
    const chiamate: string[] = [];
    const impl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      chiamate.push(url.pathname);
      if (url.pathname === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /privato\n', { status: 200 });
      }
      return new Response(pagina(VOTI), {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;
    return { impl, chiamate };
  }

  /** Il profilo come lo scriverebbe chi ha appena eseguito ispeziona-fonte. */
  const PROFILO_SITO = {
    fonte: 'il-sito',
    version: 1,
    baseUrl: 'http://sito.test',
    identificazione: {
      prodotto: 'FantaComics', versione: '1.0', contatto: 'https://fantacomics.it/bot',
    },
    attesaMinimaMs: 0,
    endpoints: {
      voti: {
        percorso: '/voti-fantacalcio-serie-a?g={matchday}',
        piano: 'globale',
        estrazione: 'json-in-html',
        bloccoHtml: '__NEXT_DATA__',
      },
    },
    mappings: {
      voti: {
        version: 1,
        root: 'props.pageProps.voti',
        fields: {
          playerId: 'id', playerName: 'nome', role: 'ruolo', serieATeam: 'squadra',
          vote: 'stats.voto', minutes: 'stats.minuti',
        },
      },
    },
  };

  it('estrae i voti dal JSON dentro la pagina', async () => {
    const { impl } = sito();
    const fonte = new FonteHttp({
      profilo: ProfiloFonteSchema.parse(PROFILO_SITO), attesa: subito, fetchImpl: impl,
    });
    const payloads = await fonte.payload('globale', CTX);
    const righe = applyMapping(payloads.voti, fonte.mappature.voti!);

    expect(righe).toHaveLength(2);
    expect(righe[0]?.playerName).toBe('Martinez L.');
    expect(righe[0]?.vote).toBe(7.5);
  });

  it('sceglie il blocco per ID, non il primo che capita', () => {
    /**
     * Una pagina ha piu' `<script>` con dentro JSON: dati strutturati per i
     * motori di ricerca, configurazione, tracciamento. Prendere il primo
     * significa prendere quello sbagliato appena il sito ne aggiunge uno.
     */
    const blocchi = jsonDentroHtml(pagina(VOTI));
    expect(blocchi.length).toBeGreaterThanOrEqual(2);
    const scelto = scegliBlocco(blocchi, '__NEXT_DATA__');
    expect(scelto?.id).toBe('__NEXT_DATA__');
  });

  it('l\'id vince anche quando un ALTRO blocco e\' piu\' grande', () => {
    /**
     * E' il caso pericoloso, e non era coperto: finche' `__NEXT_DATA__` e'
     * anche il piu' grosso, «scegli per id» e «scegli il piu' grosso» danno la
     * stessa risposta e il test passa con l'implementazione sbagliata. Il
     * giorno in cui il sito aggiunge un blob di configurazione o di
     * tracciamento piu' grande, l'estrazione cambierebbe bersaglio in silenzio
     * e il giornale uscirebbe con i dati di qualcun altro.
     */
    const conBlobGrosso = `<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { voti: VOTI } },
    })}</script>
<script id="config" type="application/json">${JSON.stringify({
      riempimento: 'x'.repeat(5000),
    })}</script>
</body></html>`;

    const blocchi = jsonDentroHtml(conBlobGrosso);
    const piuGrande = scegliBlocco(blocchi);
    expect(piuGrande?.id, 'il piu\' grande e\' il blob, non i dati').toBe('config');

    const perId = scegliBlocco(blocchi, '__NEXT_DATA__');
    expect(perId?.id).toBe('__NEXT_DATA__');
  });

  it('un id che non c\'e\' e\' un errore, non un ripiego silenzioso', () => {
    // Ripiegare sul piu' grande quando l'id manca sarebbe il modo peggiore di
    // sbagliare: nessun errore, dati di un altro blocco.
    expect(scegliBlocco(jsonDentroHtml(pagina(VOTI)), 'non-esiste')).toBeNull();
  });

  it('UNA richiesta serve tutte le leghe della stessa giornata', async () => {
    /**
     * E' la tesi del progetto applicata a un sito: il 95% del volume e'
     * identico per tutte le leghe. Dieci leghe che leggono i propri voti sono
     * dieci richieste allo stesso indirizzo per la stessa pagina — il modo
     * piu' rapido di farsi notare e bloccare.
     */
    const { impl, chiamate } = sito();
    const fonte = new FonteHttp({
      profilo: ProfiloFonteSchema.parse(PROFILO_SITO), attesa: subito, fetchImpl: impl,
    });

    for (let lega = 0; lega < 10; lega++) {
      await fonte.payload('globale', { ...CTX, leagueExternalId: `lega-${lega}` });
    }

    expect(chiamate.filter((c) => c.startsWith('/voti'))).toHaveLength(1);
    expect(fonte.stato.riusi).toBe(9);
  });

  it('e una giornata diversa e\' una richiesta diversa', async () => {
    const { impl, chiamate } = sito();
    const fonte = new FonteHttp({
      profilo: ProfiloFonteSchema.parse(PROFILO_SITO), attesa: subito, fetchImpl: impl,
    });
    await fonte.payload('globale', { ...CTX, matchday: 5 });
    await fonte.payload('globale', { ...CTX, matchday: 6 });
    expect(chiamate.filter((c) => c.startsWith('/voti'))).toHaveLength(2);
  });

  it('se la pagina cambia forma lo dice, invece di restituire niente', async () => {
    const impl = (async (u: string | URL | Request) => {
      const url = new URL(String(u));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      // Il sito ha rifatto la pagina e il blocco non si chiama piu' cosi'.
      return new Response('<html><body>Nessun dato qui</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    const fonte = new FonteHttp({
      profilo: ProfiloFonteSchema.parse(PROFILO_SITO), attesa: subito, fetchImpl: impl,
    });
    await expect(fonte.payload('globale', CTX)).rejects.toThrow(/ispeziona-fonte/);
  });
});
