/**
 * VERIFICA DELLA CATENA DEL PAGAMENTO.
 *
 * E' il percorso che decide se il prodotto incassa o viene regalato, e da qui
 * `api.stripe.com` non e' raggiungibile: senza uno Stripe finto sarebbe
 * verificabile solo in produzione, cioe' non verificato.
 *
 * Il finto fa DUE cose, ed entrambe sono quelle vere: risponde alla creazione
 * della sessione di Checkout, e manda al webhook un evento FIRMATO con lo
 * stesso HMAC che usa Stripe. La firma non viene mai disattivata — disattivarla
 * significherebbe verificare qualcos'altro.
 *
 *   pnpm exec tsx apps/worker/src/scripts/verifica-pagamento.ts
 *
 * L'app deve girare con STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e
 * STRIPE_API_BASE puntato a questo servizio.
 */
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import {
  PostgresLeagueStore, FileLeagueStore, tickConsegne, creaFonteGiornata,
  type LeagueStore,
} from '@fantacomics/pipeline';
import { DEFAULT_RULESET, stableHash, type LeagueRoster } from '@fantacomics/core';
import {
  FonteHttp, profiloServizioDiProva, stagioneDi, calendarioInArrivo, attendiFinestraUtile,
} from '@fantacomics/ingest';
import { TemplateDriver } from '@fantacomics/llm';
import { firmaComeStripe, PREZZO_CENTESIMI, VALUTA } from '@fantacomics/billing';
import { randomToken } from '@fantacomics/auth';

const base = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
const segretoWebhook = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const url = process.env.DATABASE_URL;
const PORTA = Number(process.env.STRIPE_FINTO_PORT ?? 4175);

const pool = url ? new pg.Pool({ connectionString: url }) : null;
const store: LeagueStore = pool
  ? new PostgresLeagueStore(pool)
  : new FileLeagueStore(process.env.FANTACOMICS_DATA ?? '.data');

const problemi: string[] = [];
function ok(nome: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
}

const stagione = stagioneDi(new Date());

/* ------------------------------------------------------------------ *
 * Lo Stripe finto
 * ------------------------------------------------------------------ */

type Sessione = {
  id: string;
  leagueId: string;
  season: string;
  centesimi: number;
  valuta: string;
};

const sessioni = new Map<string, Sessione>();
/** Le chiavi di idempotenza viste: e' la proprieta' che si vuole dimostrare. */
const idempotenza = new Map<string, string>();

function alzaStripeFinto(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/checkout/sessions')) {
      res.writeHead(404); res.end('no'); return;
    }
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const p = new URLSearchParams(corpo);
      const chiaveIdem = String(req.headers['idempotency-key'] ?? '');
      const gia = idempotenza.get(chiaveIdem);
      if (gia) {
        // Comportamento vero di Stripe: stessa chiave, stessa sessione.
        const s = sessioni.get(gia)!;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: s.id, url: `${base}/lega/${s.leagueId}?pagamento=ok` }));
        return;
      }

      const riferimento = p.get('client_reference_id') ?? '';
      const taglio = riferimento.lastIndexOf(':');
      const sessione: Sessione = {
        id: `cs_test_${stableHash(`${riferimento}:${Date.now()}`)}`,
        leagueId: riferimento.slice(0, taglio),
        season: riferimento.slice(taglio + 1),
        centesimi: Number(p.get('line_items[0][price_data][unit_amount]') ?? 0),
        valuta: String(p.get('line_items[0][price_data][currency]') ?? ''),
      };
      sessioni.set(sessione.id, sessione);
      if (chiaveIdem) idempotenza.set(chiaveIdem, sessione.id);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: sessione.id,
        url: `${base}/lega/${sessione.leagueId}?pagamento=ok`,
      }));
    });
  });
  return new Promise((r) => { server.listen(PORTA, '127.0.0.1', () => r(server)); });
}

/** L'evento che Stripe manderebbe a pagamento avvenuto. */
function eventoPagamento(s: Sessione, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `evt_${stableHash(s.id)}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: s.id,
        payment_status: 'paid',
        amount_total: s.centesimi,
        currency: s.valuta,
        client_reference_id: `${s.leagueId}:${s.season}`,
        customer_details: { email: 'pagante@example.com' },
        ...over,
      },
    },
  });
}

async function consegna(
  corpo: string,
  opzioni: { header?: string; quando?: number } = {},
): Promise<Response> {
  const header = opzioni.header
    ?? firmaComeStripe(corpo, segretoWebhook, opzioni.quando ?? Math.floor(Date.now() / 1000));
  return fetch(`${base}/api/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: corpo,
  });
}

/* ------------------------------------------------------------------ */

function roseDiProva(): LeagueRoster {
  return {
    season: stagione,
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

async function main(): Promise<void> {
  if (segretoWebhook === '') {
    console.error('Serve STRIPE_WEBHOOK_SECRET, lo stesso che ha l\'app.');
    process.exit(1);
  }
  const server = await alzaStripeFinto();
  console.log(`Stripe finto su http://127.0.0.1:${PORTA}`);

  const marchio = stableHash(String(Date.now()));
  const leagueId = `paga-${marchio}`;
  const publicSlug = randomToken(18);
  await store.saveConfig({
    leagueId,
    ownerId: 'acc-verifica-pagamento',
    publicSlug,
    relaySecret: null,
    leagueName: 'Lega da Pagare',
    ruleset: DEFAULT_RULESET,
    spice: 2,
    createdAt: new Date().toISOString(),
    lastMatchday: null,
    fonte: { profilo: 'servizio-di-prova', leagueExternalId: `ext-paga-${marchio}` },
  });
  await store.saveRoster(leagueId, roseDiProva());

  // 1. PRIMA DI PAGARE non esce niente, e non si spende niente.
  ok('una lega non pagata non risulta attiva',
     (await store.getEntitlement(leagueId, stagione)) === null);

  let lettureFonte = 0;
  const primaDelPagamento = await tickConsegne({
    store,
    season: stagione,
    leghe: [(await store.legheDaConsegnare()).find((l) => l.leagueId === leagueId)!],
    driver: new TemplateDriver(),
    fonte: {
      ...creaFonteGiornata({
        http: new FonteHttp({ profilo: profiloServizioDiProva('http://127.0.0.1:1') }),
        store,
        season: stagione,
      }),
      async osservazioni() { lettureFonte++; return []; },
      async storiche() { lettureFonte++; return []; },
      async calendario() { return null; },
    },
  });
  ok('il pianificatore la salta e dice perche\'',
     primaDelPagamento.esiti[0]?.azione === 'non-pagata',
     primaDelPagamento.esiti[0]?.motivo ?? '');
  ok('e non spende una sola richiesta per una lega che non paga', lettureFonte === 0);

  // 2. La sessione di pagamento si crea con l'importo deciso dal server.
  const risposta = await fetch(`http://127.0.0.1:${PORTA}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `fc-${leagueId}:${stagione}`,
    },
    body: new URLSearchParams({
      'line_items[0][price_data][unit_amount]': String(PREZZO_CENTESIMI),
      'line_items[0][price_data][currency]': VALUTA,
      client_reference_id: `${leagueId}:${stagione}`,
    }).toString(),
  });
  const creata = await risposta.json() as { id: string };
  const sessione = sessioni.get(creata.id)!;
  ok('la sessione porta 4,99 euro', sessione.centesimi === 499 && sessione.valuta === 'eur',
     `${sessione.centesimi} ${sessione.valuta}`);

  // 3. IL WEBHOOK: tutti i modi di NON farsi credere.
  const corpo = eventoPagamento(sessione);

  ok('senza firma il webhook risponde 400',
     (await consegna(corpo, { header: '' })).status === 400);
  ok('con una firma di un altro segreto risponde 400',
     (await consegna(corpo, {
       header: firmaComeStripe(corpo, 'whsec_un_altro_segreto_lungo_abbastanza'),
     })).status === 400);
  ok('con il corpo manomesso dopo la firma risponde 400',
     (await consegna(corpo.replace('"paid"', '"paid" '), {
       header: firmaComeStripe(corpo, segretoWebhook),
     })).status === 400);
  ok('con una firma vecchia di un\'ora risponde 400 (replay)',
     (await consegna(corpo, { quando: Math.floor(Date.now() / 1000) - 3600 })).status === 400);
  ok('e dopo tutti questi tentativi la lega NON e\' attiva',
     (await store.getEntitlement(leagueId, stagione)) === null);

  // Un importo diverso da quello atteso non attiva niente: e' la difesa contro
  // noi stessi, non contro un attaccante.
  const corpoScontato = eventoPagamento({ ...sessione, centesimi: 1 });
  ok('un importo diverso da 4,99 viene rifiutato',
     (await consegna(corpoScontato)).status === 400);
  ok('e nemmeno quello attiva la lega',
     (await store.getEntitlement(leagueId, stagione)) === null);

  // Un evento che non ci riguarda riceve 200: rispondere male lo fa ritentare
  // all'infinito e alla fine Stripe disattiva l'endpoint.
  const altroTipo = JSON.stringify({
    id: 'evt_altro', type: 'invoice.paid', data: { object: { id: 'in_1' } },
  });
  ok('un evento di un altro tipo riceve 200, non un errore',
     (await consegna(altroTipo)).status === 200);

  // 4. IL PAGAMENTO VERO.
  const buona = await consegna(corpo);
  ok('un evento firmato correttamente riceve 200', buona.status === 200);
  const diritto = await store.getEntitlement(leagueId, stagione);
  ok('e la lega diventa attiva', diritto !== null);
  ok('con l\'importo e la stagione giusti',
     diritto?.amountCents === 499 && diritto?.currency === 'eur' && diritto?.season === stagione,
     `${diritto?.amountCents} ${diritto?.currency} ${diritto?.season}`);

  // 5. La riconsegna dello stesso evento non raddoppia niente.
  const primoPagamento = diritto?.paidAt;
  const riconsegna = await consegna(corpo);
  ok('la riconsegna dello stesso evento riceve 200', riconsegna.status === 200);
  ok('e non registra un secondo pagamento',
     (await store.getEntitlement(leagueId, stagione))?.paidAt === primoPagamento);

  // 6. Il diritto e' PER STAGIONE.
  ok('il pagamento non apre la stagione successiva',
     (await store.getEntitlement(leagueId, '2099-00')) === null);

  // 7. Adesso il giornale esce.
  //
  // L'attesa serve nei due minuti a ridosso di un confine di finestra, dove la
  // fessura e' troppo stretta perche' il tick ci stia dentro. Capita al massimo
  // una volta al giorno; una verifica che cade due minuti su millequattrocento
  // e' una verifica di cui si smette di fidarsi.
  await attendiFinestraUtile();
  const dopo = await tickConsegne({
    store,
    season: stagione,
    leghe: [(await store.legheDaConsegnare()).find((l) => l.leagueId === leagueId)!],
    driver: new TemplateDriver(),
    fonte: {
      ...creaFonteGiornata({
        http: new FonteHttp({ profilo: profiloServizioDiProva('http://127.0.0.1:1') }),
        store,
        season: stagione,
      }),
      async osservazioni() { return []; },
      async storiche() { return []; },
      async calendario() {
        /**
         * Qui c'era una copia di «partite fra due ore», e la copia era rotta
         * esattamente come l'originale: la finestra della vigilia e' ancorata
         * al giorno locale del primo fischio, quindi a tarda sera fabbricava
         * una partita all'una di notte e il cron rispondeva «troppo presto».
         * Ne era stata corretta una sola, e questa ha fatto cadere la CI il
         * giro dopo con lo stesso messaggio. Adesso la regola sta in un posto.
         */
        return calendarioInArrivo(1);
      },
      async sfide() { return [{ homeTeamId: 't0', awayTeamId: 't1' }]; },
    },
  });
  ok('a lega attiva il pianificatore produce la vigilia',
     dopo.esiti[0]?.azione === 'vigilia-pubblicata',
     `${dopo.esiti[0]?.azione}: ${dopo.esiti[0]?.motivo ?? ''}`);

  const letta = await fetch(`${base}/g/${publicSlug}/1/vigilia`);
  ok('e il giornale si legge all\'indirizzo pubblico', letta.status === 200,
     `status ${letta.status}`);

  // 8. Un pagamento per una lega che non esiste non crea righe orfane.
  const fantasma = eventoPagamento({
    ...sessione, id: 'cs_fantasma', leagueId: `inesistente-${marchio}`,
  });
  ok('un pagamento per una lega inesistente riceve 200 ma non crea niente',
     (await consegna(fantasma)).status === 200
     && (await store.getEntitlement(`inesistente-${marchio}`, stagione)) === null);

  server.close();
  await pool?.end();
  console.log(`\n${problemi.length === 0 ? 'Pagamento: tutto verde.' : `FALLITE: ${problemi.join(', ')}`}`);
  if (problemi.length > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
