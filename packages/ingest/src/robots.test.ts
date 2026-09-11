import { describe, it, expect } from 'vitest';
import {
  analizzaRobots, consentito, scaricaRobots, ROBOTS_PERMISSIVO,
} from './collectors/robots.js';

const NOI = 'FantaComics/1.0 (+https://fantacomics.it/bot)';

describe('analisi del robots.txt', () => {
  it('prende il gruppo * quando nessuno parla di noi', () => {
    const r = analizzaRobots('User-agent: *\nDisallow: /privato\n', NOI);
    expect(consentito(r, '/voti-fantacalcio-serie-a')).toBe(true);
    expect(consentito(r, '/privato/cosa')).toBe(false);
  });

  it('preferisce il gruppo scritto per NOI a quello generico', () => {
    /**
     * Non si sommano i gruppi: prendere l'unione renderebbe piu' permissivo un
     * sito che ha scritto una regola stretta apposta per noi, che e'
     * esattamente il contrario di quello che ha chiesto.
     */
    const r = analizzaRobots([
      'User-agent: *',
      'Disallow:',
      '',
      'User-agent: FantaComics',
      'Disallow: /voti',
    ].join('\n'), NOI);
    expect(consentito(r, '/voti-fantacalcio-serie-a')).toBe(false);
  });

  it('e il gruppo generico non ci riapre quello che il nostro ci chiude', () => {
    const r = analizzaRobots([
      'User-agent: FantaComics',
      'Disallow: /',
      '',
      'User-agent: *',
      'Allow: /',
    ].join('\n'), NOI);
    expect(consentito(r, '/qualunque')).toBe(false);
  });

  it('piu\' User-agent di fila formano un gruppo solo', () => {
    const r = analizzaRobots([
      'User-agent: GoogleBot',
      'User-agent: FantaComics',
      'Disallow: /niente',
    ].join('\n'), NOI);
    expect(consentito(r, '/niente')).toBe(false);
  });

  it('a parita\' di corrispondenza vince la regola piu\' lunga', () => {
    const r = analizzaRobots([
      'User-agent: *',
      'Disallow: /voti',
      'Allow: /voti-fantacalcio-serie-a',
    ].join('\n'), NOI);
    expect(consentito(r, '/voti-fantacalcio-serie-a')).toBe(true);
    expect(consentito(r, '/voti-altro')).toBe(false);
  });

  it('e vince la piu\' lunga anche quando viene PRIMA: l\'ordine non conta', () => {
    /**
     * Nel caso qui sopra la regola lunga era anche l'ultima, quindi «vince
     * l'ultima» e «vince la piu' lunga» davano lo stesso risultato: il test
     * passava con l'implementazione sbagliata. Un robots.txt non ha un ordine
     * garantito, e leggerlo come se ce l'avesse significa vietare o permettere
     * a seconda di come il gestore ha impaginato il file.
     */
    const r = analizzaRobots([
      'User-agent: *',
      'Allow: /voti-fantacalcio-serie-a',
      'Disallow: /voti',
    ].join('\n'), NOI);
    expect(consentito(r, '/voti-fantacalcio-serie-a')).toBe(true);
    expect(consentito(r, '/voti-altro')).toBe(false);
  });

  it('a pari lunghezza vince Allow', () => {
    const r = analizzaRobots('User-agent: *\nDisallow: /x\nAllow: /x\n', NOI);
    expect(consentito(r, '/x')).toBe(true);
  });

  it('una Disallow vuota non vieta niente', () => {
    const r = analizzaRobots('User-agent: *\nDisallow:\n', NOI);
    expect(consentito(r, '/qualunque')).toBe(true);
  });

  it('capisce * e $', () => {
    const r = analizzaRobots([
      'User-agent: *',
      'Disallow: /*.json$',
      'Disallow: /api/*/interno',
    ].join('\n'), NOI);
    expect(consentito(r, '/dati/voti.json')).toBe(false);
    expect(consentito(r, '/dati/voti.json?x=1')).toBe(true); // il $ chiude
    expect(consentito(r, '/api/v2/interno')).toBe(false);
    expect(consentito(r, '/api/v2/pubblico')).toBe(true);
  });

  it('ignora i commenti e le righe senza due punti', () => {
    const r = analizzaRobots([
      '# commento',
      'roba a caso',
      'User-agent: *   # anche qui',
      'Disallow: /x    # e qui',
    ].join('\n'), NOI);
    expect(consentito(r, '/x')).toBe(false);
  });

  it('legge Crawl-delay, che non sta nella RFC ma lo scrivono in molti', () => {
    expect(analizzaRobots('User-agent: *\nCrawl-delay: 10\n', NOI).attesaSecondi).toBe(10);
    expect(analizzaRobots('User-agent: *\nCrawl-delay: 2,5\n', NOI).attesaSecondi).toBe(2.5);
    expect(analizzaRobots('User-agent: *\n', NOI).attesaSecondi).toBeNull();
  });

  it('un file vuoto o illeggibile non vieta niente', () => {
    for (const testo of ['', '\n\n', 'Disallow: /senza-agente']) {
      expect(consentito(analizzaRobots(testo, NOI), '/qualunque')).toBe(true);
    }
  });
});

describe('scarico del robots.txt', () => {
  const finto = (risposta: { stato: number; corpo: string } | 'errore') => (async () => {
    if (risposta === 'errore') throw new Error('rete giu');
    return new Response(risposta.corpo, { status: risposta.stato });
  }) as unknown as typeof fetch;

  it('lo chiede alla radice dell\'origine e si presenta', async () => {
    let vistoUrl = '';
    let vistoAgente = '';
    const impl = (async (u: string | URL | Request, init?: RequestInit) => {
      vistoUrl = String(u);
      vistoAgente = String((init?.headers as Record<string, string>)?.['user-agent'] ?? '');
      return new Response('User-agent: *\nDisallow: /x\n', { status: 200 });
    }) as unknown as typeof fetch;

    const r = await scaricaRobots('https://esempio.it/qualcosa/dentro', NOI, { fetchImpl: impl });
    expect(vistoUrl).toBe('https://esempio.it/robots.txt');
    expect(vistoAgente).toBe(NOI);
    expect(consentito(r, '/x')).toBe(false);
  });

  it('OGNI guasto si risolve in permissivo, e non e\' indulgenza', async () => {
    /**
     * Un robots.txt assente significa davvero «nessuna restrizione»: e' il
     * default del web. Trattare un errore di rete come un divieto spegnerebbe
     * il prodotto ogni volta che il sito ha un raffreddore.
     */
    for (const caso of [
      { stato: 404, corpo: 'non trovato' },
      { stato: 500, corpo: 'errore' },
      'errore' as const,
    ]) {
      const r = await scaricaRobots('https://esempio.it', NOI, { fetchImpl: finto(caso) });
      expect(r).toEqual(ROBOTS_PERMISSIVO);
    }
  });

  it('un robots.txt enorme e\' quasi sempre una pagina di errore travestita', async () => {
    const r = await scaricaRobots('https://esempio.it', NOI, {
      fetchImpl: finto({ stato: 200, corpo: 'x'.repeat(600 * 1024) }),
    });
    expect(r).toEqual(ROBOTS_PERMISSIVO);
  });
});
