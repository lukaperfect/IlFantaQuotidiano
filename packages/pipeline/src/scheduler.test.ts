import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { generateWorld, withOfficialScores, type Observation } from '@fantacomics/ingest';
import { TemplateDriver } from '@fantacomics/llm';
import { InMemoryLeagueStore, type LeagueConfig } from './store.js';
import { tickConsegne, prossimaGiornata, riassumiTick, type FonteGiornata } from './scheduler.js';

const R = DEFAULT_RULESET;

/** Martedì 6 gennaio 2026, ore 10 a Roma: dentro la finestra predefinita. */
const MARTEDI = new Date('2026-01-06T09:00:00Z');
/** Mercoledì: giornata pronta in ritardo, tipico di un posticipo. */
const MERCOLEDI = new Date('2026-01-07T09:00:00Z');
/** Domenica: la finestra non è ancora arrivata. */
const DOMENICA = new Date('2026-01-04T09:00:00Z');

function lega(over: Partial<LeagueConfig> = {}): LeagueConfig {
  return {
    leagueId: 'lega-1', ownerId: 'acc-1', publicSlug: 'slug-1', relaySecret: null,
    leagueName: 'Lega Uno', ruleset: R, spice: 2,
    createdAt: '2026-01-01T00:00:00.000Z', lastMatchday: null, ...over,
  };
}

function osservazione(over: Partial<Observation> = {}): Observation {
  return {
    fetchedAt: '2026-01-06T08:00:00.000Z', contentHash: 'abc',
    matchesFinished: 10, matchesTotal: 10,
    playersRated: 100, playersExpected: 100, ...over,
  };
}

/** Due letture identiche: è ciò che la macchina a stati chiama "stabile". */
const PRONTA: readonly Observation[] = [osservazione(), osservazione()];

function fonte(over: Partial<FonteGiornata> = {}): FonteGiornata {
  return {
    osservazioni: async () => PRONTA,
    materiale: async (config, matchday) => {
      const w = withOfficialScores(
        generateWorld({ seed: `${config.leagueId}-${matchday}`, teams: 8, matchday }),
        R,
      );
      return {
        serieA: w.serieA,
        snapshot: { ...w.snapshot, leagueId: config.leagueId, leagueName: config.leagueName },
      };
    },
    ...over,
  };
}

const tick = (over: Partial<Parameters<typeof tickConsegne>[0]> = {}) =>
  tickConsegne({
    store: new InMemoryLeagueStore(),
    fonte: fonte(),
    leghe: [lega()],
    now: MARTEDI,
    driver: new TemplateDriver(),
    ...over,
  });

describe('tick di consegna', () => {
  it('pubblica una lega quando la giornata è pronta e la finestra è aperta', async () => {
    const store = new InMemoryLeagueStore();
    const out = await tick({ store });

    expect(out.esiti).toHaveLength(1);
    expect(out.esiti[0]?.azione).toBe('pubblicata');
    expect(out.esiti[0]?.matchday).toBe(1);
    // E il giornale esiste davvero: "pubblicata" senza edizione sarebbe una bugia.
    expect(await store.getEdition('lega-1', 1)).not.toBeNull();
  });

  it('legge la giornata globale UNA volta, non una per lega', async () => {
    /**
     * È la tesi architetturale del progetto, non un'ottimizzazione. Con
     * cinquecento leghe sulla stessa giornata, chiederla per lega significa
     * cinquecento richieste identiche alla stessa piattaforma.
     */
    const leghe = Array.from({ length: 12 }, (_, i) =>
      lega({ leagueId: `lega-${i}`, publicSlug: `slug-${i}`, leagueName: `Lega ${i}` }));

    let chiamate = 0;
    const out = await tick({
      leghe,
      fonte: fonte({ osservazioni: async () => { chiamate++; return PRONTA; } }),
    });

    expect(out.esiti.filter((e) => e.azione === 'pubblicata')).toHaveLength(12);
    expect(chiamate).toBe(1);
    expect(out.lettureGlobali).toBe(1);
  });

  it('legge una volta per GIORNATA quando le leghe sono su giornate diverse', async () => {
    const leghe = [
      lega({ leagueId: 'a', publicSlug: 's-a', lastMatchday: 3 }),
      lega({ leagueId: 'b', publicSlug: 's-b', lastMatchday: 3 }),
      lega({ leagueId: 'c', publicSlug: 's-c', lastMatchday: 7 }),
    ];
    const viste: number[] = [];
    const out = await tick({
      leghe,
      fonte: fonte({ osservazioni: async (m) => { viste.push(m); return PRONTA; } }),
    });
    expect(viste).toEqual([4, 8]);
    expect(out.lettureGlobali).toBe(2);
  });

  it('non pubblica se la giornata non è chiusa', async () => {
    const out = await tick({
      fonte: fonte({
        osservazioni: async () => [osservazione({ matchesFinished: 8, matchesTotal: 10 })],
      }),
    });
    expect(out.esiti[0]?.azione).toBe('attesa-giornata');
    expect(out.esiti[0]?.motivo).toMatch(/2 partite ancora da giocare/);
  });

  it('non pubblica se i voti non sono ancora stabili', async () => {
    // Voti completi ma cambiati fra due letture: rettifiche in corso.
    const out = await tick({
      fonte: fonte({
        osservazioni: async () => [
          osservazione({ contentHash: 'prima' }),
          osservazione({ contentHash: 'dopo' }),
        ],
      }),
    });
    expect(out.esiti[0]?.azione).toBe('attesa-giornata');
    expect(out.esiti[0]?.motivo).toMatch(/stabili/);
  });

  it('consegna subito una giornata pronta in ritardo invece di perderla', async () => {
    // Un posticipo sposta la chiusura oltre il martedì. Aspettare il martedì
    // successivo significherebbe non consegnare quella giornata mai più.
    const out = await tick({ now: MERCOLEDI });
    expect(out.esiti[0]?.azione).toBe('pubblicata');
  });

  it('aspetta la finestra quando la giornata è pronta ma è troppo presto', async () => {
    const out = await tick({ now: DOMENICA });
    expect(out.esiti[0]?.azione).toBe('attesa-finestra');
  });

  it('è idempotente: due tick non producono due edizioni', async () => {
    const store = new InMemoryLeagueStore();
    const primo = await tick({ store });
    expect(primo.esiti[0]?.azione).toBe('pubblicata');

    /**
     * La seconda passata usa la STESSA configurazione, cioè quella che un cron
     * si porta dietro se ha letto le leghe prima che la pipeline avanzasse
     * `lastMatchday`. È il caso reale: senza il controllo sullo store il tick
     * rifarebbe la giornata uno a ogni giro.
     */
    const secondo = await tick({ store });
    expect(secondo.esiti[0]?.motivo).toMatch(/già presente/);
    expect(await store.listEditions('lega-1')).toEqual([1]);

    // E con la configurazione aggiornata va avanti, invece di restare fermo.
    const terzo = await tick({ store, leghe: [lega({ lastMatchday: 1 })] });
    expect(terzo.esiti[0]?.azione).toBe('pubblicata');
    expect(await store.listEditions('lega-1')).toEqual([2, 1]);
  });

  it('il guasto di una lega non ferma le altre', async () => {
    /**
     * Senza questa garanzia, una lega con dati malformati impedirebbe il
     * giornale a tutte quelle che la seguono nell'elenco — e l'ordine
     * dell'elenco non è una proprietà che qualcuno abbia scelto.
     */
    const leghe = [
      lega({ leagueId: 'sana-1', publicSlug: 's1' }),
      lega({ leagueId: 'rotta', publicSlug: 's2' }),
      lega({ leagueId: 'sana-2', publicSlug: 's3' }),
    ];
    const store = new InMemoryLeagueStore();
    const out = await tick({
      store, leghe,
      fonte: fonte({
        materiale: async (config, matchday) => {
          if (config.leagueId === 'rotta') throw new Error('formazioni illeggibili');
          const w = withOfficialScores(
            generateWorld({ seed: `${config.leagueId}-${matchday}`, teams: 8, matchday }), R,
          );
          return {
            serieA: w.serieA,
            snapshot: { ...w.snapshot, leagueId: config.leagueId, leagueName: config.leagueName },
          };
        },
      }),
    });

    expect(out.esiti.map((e) => e.azione))
      .toEqual(['pubblicata', 'errore', 'pubblicata']);
    expect(out.esiti[1]?.motivo).toMatch(/formazioni illeggibili/);
    expect(await store.getEdition('sana-2', 1)).not.toBeNull();
  });

  it('una lega senza dati aspetta, e non è un errore', async () => {
    const out = await tick({ fonte: fonte({ materiale: async () => null }) });
    expect(out.esiti[0]?.azione).toBe('attesa-dati');
  });

  it('prossimaGiornata riparte da dove si era arrivati', () => {
    expect(prossimaGiornata(lega())).toBe(1);
    expect(prossimaGiornata(lega({ lastMatchday: 12 }))).toBe(13);
  });

  it('riassume il tick in una riga leggibile da un log di cron', async () => {
    const riga = riassumiTick(await tick());
    expect(riga).toMatch(/1 leghe/);
    expect(riga).toMatch(/1 letture della giornata globale/);
    expect(riga).toMatch(/pubblicate 1/);
  });
});
