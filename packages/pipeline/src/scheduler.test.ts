import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET, type LeagueRoster } from '@fantacomics/core';
import {
  generateWorld, withOfficialScores,
  type CalendarioGiornata, type Observation,
} from '@fantacomics/ingest';
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
    expect(await store.listEditions('lega-1')).toEqual([{ matchday: 1, kind: 'giornale' }]);

    // E con la configurazione aggiornata va avanti, invece di restare fermo.
    const terzo = await tick({ store, leghe: [lega({ lastMatchday: 1 })] });
    expect(terzo.esiti[0]?.azione).toBe('pubblicata');
    expect(await store.listEditions('lega-1')).toEqual([
      { matchday: 2, kind: 'giornale' }, { matchday: 1, kind: 'giornale' },
    ]);
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

describe('il costo delle richieste', () => {
  /**
   * IL TETTO DI UN TIER GRATUITO E' LA VERA COSTRIZIONE.
   *
   * Misurato su un fine settimana di Serie A: un cron ogni dieci minuti che
   * interroga il servizio a ogni passata costa 144 richieste al giorno, contro
   * le 100 che un tier gratuito concede. Rispettando l'attesa che la macchina
   * a stati gia' calcolava — e che nessuno guardava — ne costa 27, e la
   * giornata risulta pronta sei minuti dopo.
   */
  function fonteConStoria(storia: Observation[]): FonteGiornata & { chiamate: number } {
    const f = {
      chiamate: 0,
      async storiche() { return storia; },
      async osservazioni() { f.chiamate++; return storia; },
      async materiale() { return null; },
    };
    return f;
  }

  const parziale = (fetchedAt: string): Observation => ({
    fetchedAt, contentHash: 'x',
    // Una partita ancora da giocare: la macchina a stati chiede di riprovare
    // fra un'ora.
    matchesFinished: 9, matchesTotal: 10,
    playersRated: 180, playersExpected: 220,
  });

  it('non interroga la fonte se e\'  troppo presto per riprovare', async () => {
    const fonte = fonteConStoria([parziale('2026-01-11T12:00:00.000Z')]);
    const esito = await tickConsegne({
      store: new InMemoryLeagueStore(),
      fonte,
      leghe: [lega()],
      now: new Date('2026-01-11T12:10:00.000Z'), // dieci minuti dopo
    });
    expect(fonte.chiamate).toBe(0);
    expect(esito.esiti[0]?.azione).toBe('attesa-giornata');
    expect(esito.esiti[0]?.motivo).toMatch(/riprovo fra \d+ minuti/i);
  });

  it('interroga la fonte quando l\'attesa e\' scaduta', async () => {
    const fonte = fonteConStoria([parziale('2026-01-11T12:00:00.000Z')]);
    await tickConsegne({
      store: new InMemoryLeagueStore(),
      fonte,
      leghe: [lega()],
      now: new Date('2026-01-11T13:30:00.000Z'), // un'ora e mezza dopo
    });
    expect(fonte.chiamate).toBe(1);
  });

  it('senza niente in archivio chiede, come prima', async () => {
    const fonte = fonteConStoria([]);
    await tickConsegne({
      store: new InMemoryLeagueStore(),
      fonte,
      leghe: [lega()],
      now: new Date('2026-01-11T12:10:00.000Z'),
    });
    expect(fonte.chiamate).toBe(1);
  });

  it('dieci leghe sulla stessa giornata leggono l\'archivio una volta sola', async () => {
    let storicheChieste = 0;
    const fonte: FonteGiornata = {
      async storiche() { storicheChieste++; return [parziale('2026-01-11T12:00:00.000Z')]; },
      async osservazioni() { return []; },
      async materiale() { return null; },
    };
    await tickConsegne({
      store: new InMemoryLeagueStore(),
      fonte,
      leghe: Array.from({ length: 10 }, (_, i) => lega({ leagueId: `l-${i}` })),
      now: new Date('2026-01-11T12:10:00.000Z'),
    });
    expect(storicheChieste).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Le due uscite, dal calendario vero
 * ------------------------------------------------------------------ */

describe('le due uscite della settimana', () => {
  /**
   * Una giornata da venerdi' a lunedi', come una vera.
   *
   * Gli istanti sono FISSI e non relativi ad «adesso»: sono loro a decidere
   * quale numero e' dovuto, quindi una verifica che li prendesse dall'orologio
   * sarebbe verde di giorno e rossa la notte.
   */
  const CALENDARIO: CalendarioGiornata = {
    matchday: 1,
    partite: [
      { kickoff: '2026-09-18T20:45:00+02:00' },
      { kickoff: '2026-09-20T15:00:00+02:00' },
      { kickoff: '2026-09-21T20:45:00+02:00' },
    ],
  };

  const VENERDI_MATTINA = new Date('2026-09-18T08:30:00+02:00');
  const SABATO = new Date('2026-09-19T10:00:00+02:00');
  const MARTEDI_DOPO = new Date('2026-09-22T08:30:00+02:00');
  const GIOVEDI_PRIMA = new Date('2026-09-17T10:00:00+02:00');

  const rosa = (): LeagueRoster => ({
    season: '2025-26',
    importedAt: '2026-09-01T08:00:00.000Z',
    source: 'xlsx-rose',
    teams: Array.from({ length: 4 }, (_, i) => ({
      teamId: `t${i}`,
      teamName: `Squadra ${i}`,
      players: Array.from({ length: 25 }, (_, j) => ({
        playerId: `t${i}-p${j}`,
        playerName: `Giocatore ${i}-${j}`,
        role: (['P', 'D', 'C', 'A'] as const)[j % 4] ?? 'C',
        purchasePrice: 1 + ((i * 7 + j * 3) % 60),
      })),
    })),
  });

  async function ambiente(): Promise<InMemoryLeagueStore> {
    const store = new InMemoryLeagueStore();
    await store.saveConfig(lega());
    await store.saveRoster('lega-1', rosa());
    return store;
  }

  const conCalendario = (over: Partial<FonteGiornata> = {}) => fonte({
    calendario: async () => CALENDARIO,
    sfide: async () => [
      { homeTeamId: 't0', awayTeamId: 't1' },
      { homeTeamId: 't2', awayTeamId: 't3' },
    ],
    ...over,
  });

  it('la mattina in cui si comincia esce la VIGILIA, non il retrospettivo', async () => {
    const store = await ambiente();
    const out = await tick({ store, fonte: conCalendario(), now: VENERDI_MATTINA });

    expect(out.esiti[0]?.azione).toBe('vigilia-pubblicata');
    expect(await store.getEdition('lega-1', 1, 'anteprima')).not.toBeNull();
    expect(await store.getEdition('lega-1', 1, 'giornale')).toBeNull();
    // E il puntatore NON avanza: il retrospettivo della 1 deve ancora uscire.
    expect((await store.getConfigForOwner('lega-1', 'acc-1'))?.lastMatchday).toBeNull();
  });

  it('non spende una richiesta di voti per decidere che tocca la vigilia', async () => {
    /**
     * I voti di una giornata non ancora giocata non servono a nessuno, e su un
     * tier gratuito ogni richiesta conta. Il calendario basta a saperlo.
     */
    let letture = 0;
    const store = await ambiente();
    await tick({
      store,
      fonte: conCalendario({ osservazioni: async () => { letture++; return PRONTA; } }),
      now: VENERDI_MATTINA,
    });
    expect(letture).toBe(0);
  });

  it('un secondo giro non ripubblica la vigilia', async () => {
    const store = await ambiente();
    await tick({ store, fonte: conCalendario(), now: VENERDI_MATTINA });
    const secondo = await tick({ store, fonte: conCalendario(), now: VENERDI_MATTINA });
    expect(secondo.esiti[0]?.azione).toBe('pubblicata');
    expect(secondo.esiti[0]?.motivo).toContain('gia');
    expect(await store.listEditions('lega-1')).toHaveLength(1);
  });

  it('a giornata cominciata non esce piu\' nessuna vigilia', async () => {
    /**
     * Un numero di vigilia pubblicato a partite in corso annuncia come «in
     * programma» una cosa che si sta giocando. Meglio saltare un numero che
     * stamparne uno che si contraddice — e il salto e' visibile nell'esito.
     */
    const store = await ambiente();
    const out = await tick({ store, fonte: conCalendario(), now: SABATO });
    expect(out.esiti[0]?.azione).toBe('attesa-finestra');
    expect(out.esiti[0]?.motivo).toContain('Giornata in corso');
    expect(await store.listEditions('lega-1')).toHaveLength(0);
  });

  it('prima della vigilia non esce niente, e non si chiede niente a nessuno', async () => {
    let letture = 0;
    const store = await ambiente();
    const out = await tick({
      store,
      fonte: conCalendario({ osservazioni: async () => { letture++; return PRONTA; } }),
      now: GIOVEDI_PRIMA,
    });
    expect(out.esiti[0]?.azione).toBe('attesa-finestra');
    expect(letture).toBe(0);
  });

  it('la mattina dopo l\'ultima partita esce il RETROSPETTIVO', async () => {
    const store = await ambiente();
    const out = await tick({ store, fonte: conCalendario(), now: MARTEDI_DOPO });
    expect(out.esiti[0]?.azione).toBe('pubblicata');
    expect(await store.getEdition('lega-1', 1, 'giornale')).not.toBeNull();
    // Adesso si', il puntatore avanza.
    expect((await store.getConfigForOwner('lega-1', 'acc-1'))?.lastMatchday).toBe(1);
  });

  it('i due numeri della stessa giornata convivono, in ordine', async () => {
    const store = await ambiente();
    await tick({ store, fonte: conCalendario(), now: VENERDI_MATTINA });
    await tick({ store, fonte: conCalendario(), now: MARTEDI_DOPO });

    expect(await store.listEditions('lega-1')).toEqual([
      { matchday: 1, kind: 'anteprima' }, { matchday: 1, kind: 'giornale' },
    ]);
    const vigilia = await store.getEdition('lega-1', 1, 'anteprima');
    const giornale = await store.getEdition('lega-1', 1, 'giornale');
    expect(vigilia?.pack.kind).toBe('anteprima');
    expect(giornale?.pack.kind).toBe('giornale');
    expect(vigilia?.edition.masthead.tagline).toContain('Vigilia');
    expect(giornale?.edition.masthead.tagline).not.toContain('Vigilia');
  });

  it('la vigilia esce anche senza accoppiamenti: l\'asta basta', async () => {
    /**
     * Alla prima giornata di una lega nuova il calendario di lega puo' non
     * essere ancora arrivato. Saltare il numero significherebbe lasciare senza
     * giornale proprio il cliente appena acquisito.
     */
    const store = await ambiente();
    const out = await tick({
      store,
      fonte: conCalendario({ sfide: async () => { throw new Error('non disponibile'); } }),
      now: VENERDI_MATTINA,
    });
    expect(out.esiti[0]?.azione).toBe('vigilia-pubblicata');
    expect(out.esiti[0]?.motivo).toContain('0 sfide');
  });

  it('senza rose la vigilia non esce, e lo dice', async () => {
    const store = new InMemoryLeagueStore();
    await store.saveConfig(lega());
    const out = await tick({ store, fonte: conCalendario(), now: VENERDI_MATTINA });
    expect(out.esiti[0]?.azione).toBe('attesa-dati');
    expect(out.esiti[0]?.motivo).toContain('rosa');
  });

  it('senza calendario tutto si comporta come prima', async () => {
    /**
     * Un orario mancante e' un'informazione che non abbiamo, non un divieto: se
     * questo caso fermasse le uscite, un fornitore che smette di pubblicare il
     * calendario spegnerebbe il prodotto per tutti senza un errore.
     */
    const store = await ambiente();
    const out = await tick({ store, fonte: fonte(), now: MARTEDI });
    expect(out.esiti[0]?.azione).toBe('pubblicata');
    expect(await store.getEdition('lega-1', 1, 'giornale')).not.toBeNull();
  });

  it('col calendario non si aspetta piu\' il martedi\' fisso', async () => {
    /**
     * Un turno infrasettimanale finito il mercoledi' sera deve uscire il
     * giovedi' mattina. La vecchia finestra a giorno fisso lo avrebbe tenuto
     * fermo, ed e' la premessa che questo lavoro toglie.
     */
    const infrasettimanale: CalendarioGiornata = {
      matchday: 1,
      partite: [{ kickoff: '2026-10-28T18:30:00+01:00' }, { kickoff: '2026-10-28T20:45:00+01:00' }],
    };
    const store = await ambiente();
    const out = await tick({
      store,
      fonte: conCalendario({ calendario: async () => infrasettimanale }),
      // Giovedi' 29 ottobre, mattina.
      now: new Date('2026-10-29T08:30:00+01:00'),
    });
    expect(out.esiti[0]?.azione).toBe('pubblicata');
  });
});
