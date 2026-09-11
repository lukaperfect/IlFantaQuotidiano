/**
 * Verifica della consegna automatica, sopra HTTP vero.
 *
 * Alza un servizio finto che espone i dati di una giornata come farebbe un
 * fornitore, collega tre leghe a quel servizio, e poi chiama il cron. Non
 * carica niente nessuno: e' esattamente la proprieta' da dimostrare.
 *
 * Le tre cose che conta verificare, e che un test unitario non raggiunge:
 *
 * 1. il cron e' chiuso a chi non ha il segreto;
 * 2. una giornata a META' NON viene pubblicata, perche' la macchina a stati la
 *    ferma prima — e' la garanzia che tiene in piedi la promessa «meglio
 *    nessun giornale che un giornale sbagliato» sul percorso che nessun umano
 *    guarda;
 * 3. tre leghe sulla stessa giornata leggono la Serie A UNA volta sola, non
 *    tre. Il contatore sta dentro il servizio finto, quindi la misura e' quella
 *    vera e non una spia che mi sono messo da solo nel codice.
 */
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import {
  PostgresLeagueStore, FileLeagueStore, type LeagueStore,
} from '@fantacomics/pipeline';
import { DEFAULT_RULESET, stableHash, type LeagueRoster } from '@fantacomics/core';
import {
  generateWorld, withOfficialScores, payloadPortaleDiProva, stagioneDi,
} from '@fantacomics/ingest';
import { randomToken } from '@fantacomics/auth';
import { PREZZO_CENTESIMI, VALUTA } from '@fantacomics/billing';

const base = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
const segreto = process.env.FANTACOMICS_CRON_SECRET ?? '';
const url = process.env.DATABASE_URL;

const pool = url ? new pg.Pool({ connectionString: url }) : null;
const store: LeagueStore = pool
  ? new PostgresLeagueStore(pool)
  : new FileLeagueStore(process.env.FANTACOMICS_DATA ?? '.data');

const problemi: string[] = [];
function ok(nome: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
}

/* ------------------------------------------------------------------ */
/* Il servizio finto                                                   */
/* ------------------------------------------------------------------ */

const stagione = stagioneDi(new Date());

/** Dichiara pagata una lega per questa stagione. */
async function attiva(leagueId: string): Promise<void> {
  await store.saveEntitlement({
    leagueId,
    season: stagione,
    paidAt: new Date().toISOString(),
    eventId: `evt-verifica-${leagueId}`,
    sessionId: `cs-verifica-${leagueId}`,
    amountCents: PREZZO_CENTESIMI,
    currency: VALUTA,
  });
}

/**
 * UNA GIORNATA ANCORA VERGINE, scelta guardando l'archivio.
 *
 * Le osservazioni del piano globale sono di TUTTI — stagione piu' giornata,
 * non per lega — quindi restano li' dopo la verifica. Ripartire da una
 * giornata gia' usata significa trovarsi la storia del giro precedente gia' in
 * archivio: la prima lettura risulta subito stabile, la macchina a stati
 * dichiara pronta una giornata a meta' e l'asserzione piu' importante di tutte
 * passa a vuoto.
 *
 * Prima qui c'era una giornata PSEUDOCASUALE, e non era una soluzione: con
 * trenta valori possibili e qualche esecuzione locale la collisione arriva
 * presto, e quando arriva la verifica fallisce in blocco con un messaggio che
 * punta altrove. Chiedere all'archivio quale giornata e' libera e' esatto
 * invece che probabile.
 */
async function giornataLibera(): Promise<number> {
  for (let n = 1; n <= 38; n++) {
    if ((await store.getOsservazioni(stagione, n)).length === 0) return n;
  }
  /**
   * In CI non capita mai — il database nasce con la verifica — ma in locale
   * dopo qualche decina di giri si esauriscono. Il messaggio dice cosa fare
   * invece di limitarsi a constatare: un errore che non indica l'uscita
   * costringe chi legge a ricostruire da zero come funziona l'archivio.
   */
  throw new Error(
    'Tutte le 38 giornate della stagione ' + stagione + ' hanno gia\' osservazioni in '
    + 'archivio. Per ripulire:\n'
    + '  su Postgres:  psql "$DATABASE_URL" -c "delete from serie_a_osservazioni"\n'
    + '  su file:      rm -rf .data/osservazioni',
  );
}

let GIORNATA = 1;
let mondoPieno = withOfficialScores(
  generateWorld({ seed: 'fonte-verifica', teams: 8, matchday: 1 }),
  DEFAULT_RULESET,
);

/**
 * La stessa giornata a meta': meta' delle squadre di Serie A non ha ancora
 * nessun voto. E' il segnale STRUTTURALE su cui poggia la macchina a stati.
 */
function aMeta(payload: Record<string, unknown>): Record<string, unknown> {
  const voti = JSON.parse(JSON.stringify(payload.voti)) as {
    data: { giocatori: { squadra: string; stats: { voto: number | null } }[] };
  };
  const squadre = [...new Set(voti.data.giocatori.map((g) => g.squadra))].sort();
  const senzaVoto = new Set(squadre.slice(0, Math.ceil(squadre.length / 2)));
  for (const g of voti.data.giocatori) if (senzaVoto.has(g.squadra)) g.stats.voto = null;
  return { ...payload, voti };
}

let payloadPieno = payloadPortaleDiProva(mondoPieno.serieA, mondoPieno.snapshot);
let payloadMeta = aMeta(payloadPieno);

let completa = false;

/**
 * LA FASE DELLA VIGILIA.
 *
 * Il servizio serve orari di Serie A diversi a seconda della fase, perche' e'
 * da quelli che discende quale dei due numeri e' dovuto. In fase di vigilia le
 * partite cominciano fra poche ore: la finestra e' aperta. Fuori da quella
 * fase sono di tre giorni fa, cioe' la posizione in cui tocca il
 * retrospettivo — il percorso che il resto di questa verifica prova da sempre.
 *
 * Gli orari si costruiscono attorno ad «adesso» perche' qui decide l'orologio
 * dell'app, e non gliene si puo' iniettare uno finto da fuori.
 */
let faseVigilia = false;

function partiteDiOggi(): Record<string, unknown> {
  const fra = (ore: number) => new Date(Date.now() + ore * 3600 * 1000).toISOString();
  // Fra due e quattro ore: dopo l'ora di uscita del giornale e prima del primo
  // fischio, che e' esattamente la finestra della vigilia.
  return { data: { partite: [{ inizio: fra(2) }, { inizio: fra(4) }] } };
}

/** Rose minime ma valide: la vigilia non ha altra materia di cui parlare. */
function roseDiProva(): LeagueRoster {
  return {
    season: stagioneDi(new Date()),
    importedAt: new Date().toISOString(),
    source: 'xlsx-rose',
    teams: Array.from({ length: 4 }, (_, i) => ({
      teamId: `t${i}`,
      teamName: `Squadra ${i + 1}`,
      players: Array.from({ length: 25 }, (_, j) => ({
        playerId: `t${i}-p${j}`,
        playerName: `Giocatore ${i}-${j}`,
        role: (['P', 'D', 'C', 'A'] as const)[j % 4] ?? 'C',
        purchasePrice: 1 + ((i * 13 + j * 7) % 80),
      })),
    })),
  };
}

/**
 * Il conteggio e' per CHIAVE PRECISA — endpoint piu' giornata, endpoint piu'
 * lega — non per endpoint e basta.
 *
 * Nello store restano le leghe dei giri precedenti, e il cron le processa
 * tutte: un totale per endpoint misurerebbe anche quelle e direbbe «tre
 * letture» dove invece la proprieta' da dimostrare riguarda solo le mie. Con
 * una chiave precisa la misura e' esatta comunque sia messo l'ambiente.
 */
const richieste = new Map<string, number>();

/**
 * Porta FISSA, non effimera: l'app deve conoscere l'indirizzo del servizio
 * PRIMA che il servizio esista, perche' lo legge dall'ambiente all'avvio. Con
 * una porta a caso ci sarebbe da far ripartire l'app a ogni giro.
 */
const PORTA = Number(process.env.FANTACOMICS_FONTE_PORT ?? 4174);

function alzaServizio(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const nome = u.pathname.slice(1);
    const dettaglio = u.searchParams.get('giornata')
      ?? u.searchParams.get('lega')
      ?? '';
    const chiave = dettaglio ? `${nome}:${dettaglio}` : nome;
    richieste.set(chiave, (richieste.get(chiave) ?? 0) + 1);

    const sorgente = completa ? payloadPieno : payloadMeta;
    const corpo = nome === 'partite' && faseVigilia ? partiteDiOggi() : sorgente[nome];
    if (corpo === undefined) { res.writeHead(404); res.end('non trovato'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corpo));
  });
  return new Promise((r) => {
    server.listen(PORTA, '127.0.0.1', () => {
      r({ server, baseUrl: `http://127.0.0.1:${PORTA}` });
    });
  });
}

/**
 * `forza` salta l'attesa fra una richiesta e l'altra.
 *
 * Qui serve perche' la verifica comprime in pochi secondi quello che nella
 * realta' succede in due giorni: senza, il secondo giro verrebbe
 * (giustamente) saltato. Non salta nessun cancello di correttezza — la
 * giornata a meta' resta bloccata lo stesso, ed e' proprio cio' che si
 * verifica sotto.
 */
async function tick(conSegreto: string | null, forza = false): Promise<Response> {
  return fetch(`${base}/api/tick${forza ? '?forza=1' : ''}`, {
    method: 'POST',
    headers: conSegreto ? { authorization: `Bearer ${conSegreto}` } : {},
  });
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (segreto === '') {
    console.error('Serve FANTACOMICS_CRON_SECRET, lo stesso che ha l’app.');
    process.exit(1);
  }

  /**
   * La giornata si sceglie PRIMA di alzare il servizio: da lei dipendono i
   * payload che il servizio serve.
   */
  GIORNATA = await giornataLibera();
  mondoPieno = withOfficialScores(
    generateWorld({ seed: 'fonte-verifica', teams: 8, matchday: GIORNATA }),
    DEFAULT_RULESET,
  );
  payloadPieno = payloadPortaleDiProva(mondoPieno.serieA, mondoPieno.snapshot);
  payloadMeta = aMeta(payloadPieno);
  console.log(`giornata libera scelta: ${GIORNATA}`);

  const { server, baseUrl } = await alzaServizio();
  console.log(`servizio finto su ${baseUrl}`);
  if (process.env.FANTACOMICS_FONTE_URL !== baseUrl) {
    console.error(
      `L’app deve puntare a questo servizio: FANTACOMICS_FONTE_URL=${baseUrl}\n` +
      `Ricevuto invece: ${process.env.FANTACOMICS_FONTE_URL ?? '(vuoto)'}`,
    );
    server.close();
    process.exit(1);
  }

  const marchio = stableHash(String(Date.now()));
  const leghe = [0, 1, 2].map((i) => ({
    leagueId: `fonte-${marchio}-${i}`,
    publicSlug: randomToken(18),
    // Anche l'identificativo presso il servizio dev'essere di questo giro: le
    // leghe dei giri precedenti restano nello store e chiederebbero gli
    // stessi, falsando il conteggio delle letture.
    esterno: `ext-${marchio}-${i}`,
  }));

  for (const [i, l] of leghe.entries()) {
    await store.saveConfig({
      leagueId: l.leagueId,
      ownerId: 'acc-verifica-fonte',
      publicSlug: l.publicSlug,
      relaySecret: null,
      leagueName: `Lega Automatica ${i + 1}`,
      ruleset: DEFAULT_RULESET,
      spice: 2,
      createdAt: new Date().toISOString(),
      // La prossima giornata di una lega e' l'ultima piu' uno: si parte da
      // quella prima di quella che si vuole verificare.
      lastMatchday: GIORNATA - 1,
      fonte: { profilo: 'servizio-di-prova', leagueExternalId: l.esterno },
    });
    // Senza diritto a pubblicare il pianificatore le salterebbe, ed e' giusto
    // cosi': quello e' il percorso che verifica `verifica-pagamento.ts`. Qui si
    // verifica la CONSEGNA, quindi le leghe si danno per pagate.
    await attiva(l.leagueId);
  }

  // 1. Il cron e' chiuso a chi non ha il segreto.
  ok('senza segreto il cron risponde 401', (await tick(null)).status === 401);
  ok('con un segreto sbagliato risponde uguale', (await tick('sbagliato')).status === 401);

  // 2. Giornata a meta': si legge, ma NON si pubblica.
  richieste.clear();
  const parziale = await tick(segreto);
  const esitoParziale = await parziale.json() as {
    esiti: { leagueId: string; azione: string; motivo: string }[]; lettureGlobali: number;
  };
  const idMiei = new Set(leghe.map((l) => l.leagueId));
  const parzialiMiei = esitoParziale.esiti.filter((e) => idMiei.has(e.leagueId));
  ok('il cron autenticato risponde 200', parziale.status === 200);
  ok('una giornata a meta\' non viene pubblicata',
     parzialiMiei.length === 3 && parzialiMiei.every((e) => e.azione !== 'pubblicata'),
     parzialiMiei.map((e) => e.azione).join(','));
  ok('e dice che sta aspettando la giornata',
     parzialiMiei.some((e) => e.azione === 'attesa-giornata'),
     parzialiMiei[0]?.motivo ?? '');

  // Il giornale non deve esistere a nessun indirizzo pubblico.
  const primaDelTempo = await fetch(`${base}/g/${leghe[0]!.publicSlug}/${GIORNATA}`);
  ok('nessun giornale all\'indirizzo pubblico finche\' la giornata non e\' finita',
     primaDelTempo.status === 404, `status ${primaDelTempo.status}`);

  // 2-bis. L'ECONOMIA DELLE RICHIESTE, verificata dove si vede davvero.
  //
  //    La macchina a stati ha appena detto «cinque partite da giocare,
  //    riprova fra un'ora». Un secondo giro subito dopo NON deve interrogare
  //    il servizio: misurato su un fine settimana vero, rispettare quell'attesa
  //    porta un cron da 144 richieste al giorno a 27. Con un tetto gratuito di
  //    100 e' la differenza fra funzionare e non funzionare.
  richieste.clear();
  await tick(segreto);
  ok('un secondo giro subito dopo non spende una richiesta',
     (richieste.get(`voti:${GIORNATA}`) ?? 0) === 0,
     `letture di /voti: ${richieste.get(`voti:${GIORNATA}`) ?? 0}`);

  //    E con «forza» invece la spende: e' la leva dell'operatore dopo un
  //    guasto del fornitore.
  richieste.clear();
  await tick(segreto, true);
  ok('con «forza» la richiesta parte lo stesso',
     (richieste.get(`voti:${GIORNATA}`) ?? 0) === 1,
     `letture di /voti: ${richieste.get(`voti:${GIORNATA}`) ?? 0}`);

  // 3. Giornata completa. UN SOLO giro non basta: la politica chiede due
  //    letture consecutive identiche, cioe' la prova che i voti si sono
  //    fermati. Pubblicare alla prima lettura completa significherebbe uscire
  //    mentre l'ultimo posticipo sta ancora aggiornando i voti.
  completa = true;
  const primoCompleto = await tick(segreto, true);
  const esitoPrimo = await primoCompleto.json() as {
    esiti: { leagueId: string; azione: string; motivo: string }[];
  };
  const primiMiei = esitoPrimo.esiti.filter((e) => idMiei.has(e.leagueId));
  ok('la prima lettura completa non pubblica ancora',
     primiMiei.length === 3 && primiMiei.every((e) => e.azione !== 'pubblicata'),
     primiMiei[0]?.motivo ?? '');
  ok('e dice che aspetta letture stabili',
     /stabil/i.test(primiMiei[0]?.motivo ?? ''),
     primiMiei[0]?.motivo ?? '');

  // 4. Seconda lettura identica: adesso esce, e le tre leghe leggono la Serie
  //    A UNA volta sola.
  richieste.clear();
  const pieno = await tick(segreto, true);
  const esitoPieno = await pieno.json() as {
    esiti: { leagueId: string; azione: string; motivo: string; confidenza?: number }[];
    lettureGlobali: number;
  };

  const miei = new Set(leghe.map((l) => l.leagueId));
  const esitiMiei = esitoPieno.esiti.filter((e) => miei.has(e.leagueId));
  const pubblicate = esitiMiei.filter(
    (e) => e.azione === 'pubblicata' || e.azione === 'in-revisione',
  );
  ok('a giornata finita le tre leghe producono un\'edizione',
     pubblicate.length === 3,
     esitiMiei.map((e) => `${e.azione}${e.motivo ? `(${e.motivo})` : ''}`).join(' | '));

  ok('la Serie A e\' stata letta UNA volta per tre leghe, non tre',
     richieste.get(`voti:${GIORNATA}`) === 1,
     `letture di /voti per la giornata ${GIORNATA}: ${richieste.get(`voti:${GIORNATA}`) ?? 0}`);
  const formazioniMie = leghe
    .map((l) => richieste.get(`formazioni:${l.esterno}`) ?? 0)
    .reduce((a, b) => a + b, 0);
  ok('il piano della lega invece e\' stato letto una volta per lega',
     formazioniMie === 3, `letture di /formazioni per le mie tre leghe: ${formazioniMie}`);

  // 5. Il giornale esiste davvero: «pubblicata» non basta come prova.
  const pagina = await fetch(`${base}/g/${leghe[0]!.publicSlug}/${GIORNATA}`);
  const html = await pagina.text();
  ok('il giornale e\' leggibile all\'indirizzo pubblico', pagina.status === 200,
     `status ${pagina.status}`);
  ok('e contiene pezzi veri', (html.match(/<article/g) ?? []).length >= 3,
     `${(html.match(/<article/g) ?? []).length} pezzi`);
  ok('ed e\' la lega giusta', html.includes('Lega Automatica 1'));

  // 6. Ripassare non ripubblica.
  //
  //    Attenzione a cosa si sta misurando: dopo la pubblicazione il puntatore
  //    della lega avanza, quindi il giro successivo guarda la giornata DOPO.
  //    Chiedere solo «non ha pubblicato» darebbe verde anche se avesse
  //    rigenerato la giornata 1 — quindi si verifica sia dove e' andato il
  //    tick, sia che il giornale gia' uscito sia rimasto quello di prima.
  const primaVersione = await (await fetch(`${base}/g/${leghe[0]!.publicSlug}/${GIORNATA}`)).text();
  const ripasso = await tick(segreto, true);
  const esitoRipasso = await ripasso.json() as {
    esiti: { leagueId: string; azione: string; matchday: number }[];
  };
  const ripassoMiei = esitoRipasso.esiti.filter((e) => miei.has(e.leagueId));
  ok('il giro successivo passa alla giornata dopo',
     ripassoMiei.length === 3 && ripassoMiei.every((e) => e.matchday === GIORNATA + 1),
     ripassoMiei.map((e) => `g${e.matchday}:${e.azione}`).join(','));

  const secondaVersione = await (await fetch(`${base}/g/${leghe[0]!.publicSlug}/${GIORNATA}`)).text();
  ok('e il giornale gia\' uscito non viene rigenerato',
     primaVersione === secondaVersione && primaVersione.length > 0,
     `${primaVersione.length} byte contro ${secondaVersione.length}`);

  /**
   * 8. LA VIGILIA, dal cron, sopra HTTP vero.
   *
   * Fin qui si e' provato il retrospettivo. Questa parte prova l'altra meta':
   * con le partite che cominciano fra poche ore il cron deve produrre un numero
   * di VIGILIA, e deve farlo senza spendere una richiesta di voti — di una
   * giornata non ancora giocata non servono a nessuno.
   */
  faseVigilia = true;
  const legaVigilia = `vigilia-${marchio}`;
  const slugVigilia = randomToken(18);
  await store.saveConfig({
    leagueId: legaVigilia,
    ownerId: 'acc-verifica-fonte',
    publicSlug: slugVigilia,
    relaySecret: null,
    leagueName: 'Lega della Vigilia',
    ruleset: DEFAULT_RULESET,
    spice: 2,
    createdAt: new Date().toISOString(),
    lastMatchday: null,
    fonte: { profilo: 'servizio-di-prova', leagueExternalId: `ext-vigilia-${marchio}` },
  });
  await store.saveRoster(legaVigilia, roseDiProva());
  await attiva(legaVigilia);

  richieste.clear();
  const giroVigilia = await tick(segreto, true);
  const esitoVigilia = await giroVigilia.json() as {
    esiti: { leagueId: string; azione: string; motivo: string }[];
  };
  const mia = esitoVigilia.esiti.find((e) => e.leagueId === legaVigilia);
  ok('con le partite in arrivo il cron produce la VIGILIA',
     mia?.azione === 'vigilia-pubblicata', `${mia?.azione}: ${mia?.motivo ?? ''}`);

  const edizioniVigilia = await store.listEditions(legaVigilia);
  ok('e l\'edizione salvata e\' di tipo anteprima',
     edizioniVigilia.length === 1 && edizioniVigilia[0]?.kind === 'anteprima',
     JSON.stringify(edizioniVigilia));
  ok('il puntatore NON avanza: il retrospettivo di quella giornata deve ancora uscire',
     (await store.getConfigForOwner(legaVigilia, 'acc-verifica-fonte'))?.lastMatchday === null);

  const letta = await fetch(`${base}/g/${slugVigilia}/1/vigilia`);
  ok('il numero di vigilia e\' leggibile all\'indirizzo pubblico',
     letta.status === 200, `status ${letta.status}`);
  const paginaVigilia = await letta.text();
  ok('e non annuncia risultati che non esistono',
     !paginaVigilia.includes('Risultati') && paginaVigilia.includes('Vigilia'));

  await tick(segreto, true);
  ok('un secondo giro non ripubblica la vigilia',
     (await store.listEditions(legaVigilia)).length === 1);

  server.close();
  await pool?.end();

  if (problemi.length > 0) {
    console.error(`\n${problemi.length} problemi:\n- ${problemi.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\nConsegna automatica: tutto verde.');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
