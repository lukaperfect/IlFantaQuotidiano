import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiloFonte, profiliDaAmbiente, profiloFantacalcioIt } from './profili-fonte.js';
import { estraiDaDom } from './collectors/dom-tabella.js';
import { applyMapping, mappingCoverage } from './collectors/extension-relay.js';

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

describe('il profilo di fantacalcio.it, contro la pagina vera', () => {
  /**
   * Questo test non prova l'estrattore — quello ha i suoi. Prova il PROFILO:
   * che quei selettori e quella mappatura, messi insieme, producano i campi
   * canonici a partire da un ritaglio della pagina come e' stata pubblicata.
   *
   * E' l'unica prova che conta davvero: un profilo scritto a tavolino sembra
   * pronto e cade al primo dato vero, che e' l'errore contro cui e' costruito
   * tutto il resto del progetto.
   */
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'voti-pagina.html'),
    'utf8',
  );
  const profilo = profiloFantacalcioIt();
  const righe = estraiDaDom(html, profilo.endpoints.voti!.selettori!);
  const canonici = applyMapping(righe, profilo.mappings.voti!);
  const di = (nome: string) => canonici.find((r) => r.playerName === nome);

  it('estrae i giocatori con i campi canonici pieni', () => {
    expect(canonici).toHaveLength(16);
    const { ratio, missing } = mappingCoverage(
      canonici, ['playerId', 'playerName', 'role', 'serieATeam'],
    );
    expect(missing).toEqual({});
    expect(ratio).toBe(1);
  });

  it('la squadra viene dall\'intestazione, col nome che si legge a schermo', () => {
    expect(new Set(canonici.map((r) => r.serieATeam))).toEqual(new Set(['Atalanta']));
  });

  it('i ruoli sono quelli canonici, non quelli del sito', () => {
    expect(new Set(canonici.map((r) => r.role))).toEqual(new Set(['P', 'D', 'C', 'A']));
  });

  it('i cartellini diventano contatori, e l\'assenza resta assenza', () => {
    expect(di('Bellanova')).toMatchObject({ yellowCards: '1', redCards: null });
    expect(di('Gaetano')).toMatchObject({ yellowCards: null, redCards: '1' });
    expect(di('Scalvini')).toMatchObject({ yellowCards: null, redCards: null });
  });

  it('i bonus arrivano interi, e il fantavoto ufficiale con loro', () => {
    expect(di('Ederson D.S.')).toMatchObject({ vote: 7, goals: 1, officialFantaVote: 10 });
    expect(di('Carnesecchi')).toMatchObject({ vote: 7, goalsConceded: 2, officialFantaVote: 5 });
  });

  it('un giocatore senza voto NON arriva con un voto inventato', () => {
    // E' il campo su cui si regge tutto: la macchina a stati conta le squadre
    // che hanno voti, e il motore sostituisce chi non ne ha.
    expect(di('Kessiè')).toMatchObject({ vote: null, officialFantaVote: null });
  });

  it('la giornata dichiarata dalla pagina e\' quella che il cancello confronta', () => {
    expect(new Set(righe.map((r) => r.giornata))).toEqual(new Set([3]));
  });

  it('le partite escono una per incontro, non una per squadra', () => {
    // Nel ritaglio c'e' la tabella dell'Atalanta, che gioca IN TRASFERTA: la
    // riga della partita deve venire dalla tabella della squadra di casa, e
    // qui quindi non ce n'e' nessuna. E' il verso giusto del filtro.
    const partite = estraiDaDom(html, profilo.endpoints.partite!.selettori!);
    expect(partite).toHaveLength(0);
  });
});
