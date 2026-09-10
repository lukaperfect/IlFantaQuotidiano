import {
  parseEnvelope, importFromRelay, coperturaMinima, detectDrift, profiloDi,
  stagioneDi, AdapterError,
} from '@fantacomics/ingest';
import { runMatchdayPipeline } from '@fantacomics/pipeline';
import { TemplateDriver, AnthropicDriver } from '@fantacomics/llm';
import { store } from '@/lib/store';
import type { LeagueConfig } from '@fantacomics/pipeline';

export const dynamic = 'force-dynamic';

/**
 * L'ENDPOINT DELL'ESTENSIONE.
 *
 * Riceve i payload JSON che la pagina della piattaforma ha gia' scaricato
 * nella sessione dell'utente. Tre proprieta' che nessuno scraping lato server
 * ha: nessuna credenziale custodita, nessun rischio di ban (traffico
 * dell'utente, volumi umani), e payload che cambiano molto piu' lentamente
 * del DOM.
 *
 * DA DOVE VIENE L'IDENTITA' DELLA LEGA. Dalla chiave nell'header, mai dal
 * corpo. L'envelope porta un `leagueExternalId`, ma e' un'etichetta
 * diagnostica: se decidesse lei a quale lega appartengono i dati, chiunque
 * potrebbe scrivere nell'archivio di chiunque scrivendo un identificatore
 * diverso. La chiave e' un capability distinto dallo slug pubblico — quello fa
 * leggere il giornale, questa fa entrare dati — e si ruota o si revoca dalla
 * pagina della lega.
 *
 * IL MAPPING NON ARRIVA DAL CLIENT. Sta sul server ed e' il server ad
 * applicarlo: un client che porta con se' la propria mappatura puo' far
 * sembrare qualunque cosa qualunque altra, e comunque vanificherebbe il motivo
 * per cui la mappatura e' un dato — poterla correggere senza ripubblicare
 * l'estensione e senza aspettare che gli utenti aggiornino.
 */

/** Sotto questa copertura non si pubblica: si segnala una deriva. */
const COPERTURA_MINIMA = 0.95;

const CORS = {
  // L'estensione chiama da un'origine che non e' la nostra. Nessun cookie e'
  // coinvolto — l'autenticazione e' l'header Bearer — quindi aprire l'origine
  // non espone la sessione di nessuno: un sito ostile non conosce la chiave.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
} as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Risolve la chiave.
 *
 * Header assente e chiave sconosciuta rispondono identicamente: distinguerli
 * direbbe a un estraneo quali chiavi esistono, che e' la stessa ragione per
 * cui una lega altrui e una lega inesistente danno lo stesso 404.
 */
async function legaDallaChiave(request: Request): Promise<LeagueConfig | null> {
  const header = request.headers.get('authorization') ?? '';
  const chiave = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (chiave === '') return null;
  return store.getConfigByRelaySecret(chiave);
}

function driver() {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicDriver() : new TemplateDriver();
}

/**
 * Dice all'estensione dove guardare.
 *
 * E' il profilo di piattaforma, cioe' l'elenco di URL da osservare e i nomi
 * dei campi: si aggiorna qui e l'estensione lo prende alla prossima apertura.
 * Le mappature non vengono mandate al client — non gli servono, ed e' il
 * server ad applicarle.
 */
export async function GET(request: Request): Promise<Response> {
  const config = await legaDallaChiave(request);
  if (!config) return json({ errore: 'Chiave non valida.' }, 401);

  const platform = new URL(request.url).searchParams.get('platform') ?? 'portale-di-prova';
  const profilo = profiloDi(platform);
  if (!profilo) return json({ errore: `Nessun profilo per "${platform}".` }, 404);

  return json({
    lega: config.leagueName,
    platform: profilo.platform,
    version: profilo.version,
    hosts: profilo.hosts,
    capture: profilo.capture,
    obbligatori: ['voti', 'formazioni', 'calendario'],
  });
}

export async function POST(request: Request): Promise<Response> {
  const config = await legaDallaChiave(request);
  if (!config) return json({ errore: 'Chiave non valida.' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ errore: 'Corpo non JSON.' }, 400);
  }

  try {
    // Tutto cio' che arriva da un client e' ostile finche' non e' validato.
    const envelope = parseEnvelope(body);

    const profilo = profiloDi(envelope.platform);
    if (!profilo) return json({ errore: `Nessun profilo per "${envelope.platform}".` }, 422);

    const { serieA, snapshot, copertura } = importFromRelay(envelope, profilo, {
      leagueId: config.leagueId,
      leagueName: config.leagueName,
      season: envelope.season ?? stagioneDi(new Date(envelope.capturedAt)),
    });

    // La copertura e' il canary: se crolla, la piattaforma e' cambiata sotto i
    // piedi. Meglio nessun giornale che un giornale pieno di senza voto.
    const minima = coperturaMinima(copertura);
    if (minima < COPERTURA_MINIMA) {
      return json({
        accettato: false,
        stato: 'deriva-sospetta',
        copertura: copertura.map((c) => ({ ...c, ratio: Number(c.ratio.toFixed(3)) })),
        nota: 'Il profilo non estrae abbastanza campi: la piattaforma e’ probabilmente ' +
              'cambiata. Nulla e’ stato pubblicato.',
      }, 422);
    }

    /**
     * La pipeline gira dentro la richiesta.
     *
     * E' una scelta consapevole e temporanea: l'utente ha appena premuto un
     * bottone e sta guardando, quindi qualche secondo e' accettabile, e non
     * esiste ancora una coda durabile da cui riprendere. Gli step della
     * pipeline sono gia' espliciti e senza stato nascosto proprio perche'
     * questo passaggio, quando servira', sia un lavoro di giorni e non un
     * rifacimento.
     */
    const esito = await runMatchdayPipeline({
      snapshot, serieA,
      rules: config.ruleset,
      store,
      driver: driver(),
      spice: config.spice,
    });

    return json({
      accettato: true,
      lega: config.leagueName,
      giornata: envelope.matchday,
      squadre: snapshot.teams.length,
      copertura: Number(minima.toFixed(3)),
      confidenza: esito.edition.meta.confidence,
      pubblicata: esito.publishable,
      ridotta: esito.edition.meta.degraded,
      indirizzo: `/g/${config.publicSlug}/${envelope.matchday}`,
    });
  } catch (e) {
    if (e instanceof AdapterError) {
      return json({ errore: e.message, tipo: e.kind, recuperabile: e.retryable }, 422);
    }
    return json({ errore: e instanceof Error ? e.message : 'Errore sconosciuto.' }, 400);
  }
}

/** Confronto di forma contro una fixture di riferimento: il canary su richiesta. */
export async function PUT(request: Request): Promise<Response> {
  const config = await legaDallaChiave(request);
  if (!config) return json({ errore: 'Chiave non valida.' }, 401);

  try {
    const { corrente, riferimento } = (await request.json()) as {
      corrente: unknown; riferimento: unknown;
    };
    const report = detectDrift(corrente, riferimento);
    return json(report, report.ok ? 200 : 422);
  } catch (e) {
    return json({ errore: e instanceof Error ? e.message : 'Errore sconosciuto.' }, 400);
  }
}
