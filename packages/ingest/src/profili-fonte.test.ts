import { describe, it, expect } from 'vitest';
import { profiloFonte, profiliDaAmbiente } from './profili-fonte.js';

/**
 * I profili configurati sono la differenza fra «collegare una fonte vera è un
 * rilascio» e «collegare una fonte vera è una variabile d'ambiente». Fino a
 * ieri il file prometteva la seconda e implementava la prima.
 */

const PROFILO_MINIMO = {
  fonte: 'il-sito',
  version: 1,
  baseUrl: 'https://www.esempio.it',
  identificazione: { prodotto: 'FantaComics', versione: '1.0', contatto: 'https://x.it/bot' },
  endpoints: { voti: { percorso: '/api/voti?g={matchday}', piano: 'globale' } },
  mappings: {
    voti: { version: 1, root: 'dati', fields: { playerId: 'id', vote: 'voto' } },
  },
};

const env = (profili: unknown): NodeJS.ProcessEnv =>
  ({ FANTACOMICS_PROFILI_FONTE: JSON.stringify(profili) } as NodeJS.ProcessEnv);

describe('profili di fonte dalla configurazione', () => {
  it('senza configurazione restituisce niente, senza lamentarsi', () => {
    expect(profiliDaAmbiente({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('legge un profilo vero e lo valida con lo stesso schema degli interni', () => {
    const p = profiloFonte('il-sito', undefined, env({ 'il-sito': PROFILO_MINIMO }));
    expect(p?.fonte).toBe('il-sito');
    expect(p?.baseUrl).toBe('https://www.esempio.it');
    // I valori predefiniti dello schema si applicano anche qui: il rispetto di
    // robots.txt non va dimenticato solo perche' il profilo arriva da fuori.
    expect(p?.rispettaRobots).toBe(true);
  });

  it('la configurazione VINCE sugli incorporati', () => {
    const mio = { ...PROFILO_MINIMO, fonte: 'servizio-di-prova', baseUrl: 'https://altrove.it' };
    const p = profiloFonte('servizio-di-prova', 'http://127.0.0.1:4174', env({
      'servizio-di-prova': mio,
    }));
    expect(p?.baseUrl).toBe('https://altrove.it');
  });

  it('e senza configurazione gli incorporati continuano a funzionare', () => {
    const p = profiloFonte('servizio-di-prova', 'http://127.0.0.1:4174', {} as NodeJS.ProcessEnv);
    expect(p?.fonte).toBe('servizio-di-prova');
  });

  it('un profilo sconosciuto resta null, non un\'eccezione', () => {
    // Una lega configurata su un profilo che non esiste piu' non deve far
    // cadere il tick delle altre.
    expect(profiloFonte('mai-visto', undefined, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('un JSON malformato lancia SUBITO, con il motivo', () => {
    /**
     * All'avvio, quando qualcuno sta guardando — non alla prima giornata da
     * consegnare, di domenica sera.
     */
    expect(() => profiliDaAmbiente({
      FANTACOMICS_PROFILI_FONTE: '{non json',
    } as NodeJS.ProcessEnv)).toThrow(/JSON valido/);
  });

  it('un profilo INCOMPLETO lancia dicendo quale campo manca', () => {
    const rotto = { ...PROFILO_MINIMO, endpoints: { voti: { piano: 'globale' } } };
    expect(() => profiliDaAmbiente(env({ 'il-sito': rotto })))
      .toThrow(/il-sito.*percorso/s);
  });

  it('un elenco invece di un oggetto lo dice invece di ignorarlo', () => {
    expect(() => profiliDaAmbiente(env([PROFILO_MINIMO]))).toThrow(/oggetto/);
  });
});
