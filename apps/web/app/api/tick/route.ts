import { timingSafeEqual, createHash } from 'node:crypto';
import {
  FonteHttp, profiloFonte, stagioneDi, AdapterError, POLITICA_CRON,
} from '@fantacomics/ingest';
import { creaFonteGiornata, tickConsegne } from '@fantacomics/pipeline';
import { TemplateDriver, AnthropicDriver } from '@fantacomics/llm';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * IL TICC DEL CRON: il giornale esce senza che nessuno faccia niente.
 *
 * È l'endpoint che un pianificatore esterno chiama a intervalli. Non decide se
 * la giornata è finita — quello lo fa la macchina a stati leggendo le
 * osservazioni accumulate — e non cicla: una passata e torna. È ciò che lo
 * rende eseguibile da un cron di piattaforma, da una coda durabile o da una
 * chiamata a mano senza cambiare una riga.
 *
 * PERCHÉ È AUTENTICATO, VISTO CHE NON RESTITUISCE DATI DI NESSUNO. Perché
 * costa: ogni passata interroga un servizio a consumo e può far girare la
 * pipeline su tutte le leghe collegate. Un endpoint del genere lasciato aperto
 * non è una fuga di dati, è una fattura — e un modo comodo per far esaurire a
 * qualcun altro la quota della giornata.
 */

function autorizzato(req: Request): boolean {
  const atteso = process.env.FANTACOMICS_CRON_SECRET ?? '';
  // Senza segreto configurato l'endpoint è chiuso, non aperto. Il valore
  // predefinito di una porta è chiusa.
  if (atteso === '') return false;

  const header = req.headers.get('authorization') ?? '';
  const fornito = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (fornito === '') return false;

  // Confronto a tempo costante su lunghezze normalizzate: confrontare stringhe
  // di lunghezza diversa con timingSafeEqual lancia, e farlo con === perde per
  // definizione la proprietà che si stava cercando.
  const a = createHash('sha256').update(fornito).digest();
  const b = createHash('sha256').update(atteso).digest();
  return timingSafeEqual(a, b);
}

// Senza chiave si usa il driver template: il giornale esce comunque, più
// secco. Un prodotto settimanale che salta una settimana perde gli abbonati.
function driver() {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicDriver() : new TemplateDriver();
}

export async function POST(req: Request): Promise<Response> {
  if (!autorizzato(req)) {
    // Segreto assente e segreto sbagliato rispondono identicamente.
    return Response.json({ errore: 'non autorizzato' }, {
      status: 401, headers: { 'cache-control': 'no-store' },
    });
  }

  /**
   * `?forza=1` — ricontrolla adesso, senza aspettare l'intervallo che la
   * macchina a stati aveva chiesto. E' per l'operatore dopo un guasto del
   * fornitore, e costa richieste: per questo sta dietro lo stesso segreto e
   * non e' il comportamento predefinito.
   */
  const forza = new URL(req.url).searchParams.get('forza') === '1';

  const leghe = await store.legheDaConsegnare();
  if (leghe.length === 0) {
    return Response.json(
      { esiti: [], nota: 'Nessuna lega ha una fonte automatica configurata.' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const season = stagioneDi(new Date());
  const baseUrl = process.env.FANTACOMICS_FONTE_URL;
  const chiave = process.env.FANTACOMICS_FONTE_CHIAVE;

  /**
   * Le leghe si raggruppano per profilo, e ogni gruppo ha UNA fonte.
   *
   * È lì che vive l'inversione architetturale: la cache del piano globale sta
   * dentro l'oggetto fonte, quindi una fonte per profilo significa una lettura
   * di Serie A per giornata. Costruirne una per lega annullerebbe la cache
   * senza che niente lo segnali — sarebbe corretto e dieci volte più caro.
   */
  const perProfilo = new Map<string, typeof leghe>();
  for (const lega of leghe) {
    const nome = lega.fonte!.profilo;
    perProfilo.set(nome, [...(perProfilo.get(nome) ?? []), lega]);
  }

  const esiti = [];
  let lettureGlobali = 0;

  for (const [nome, gruppo] of perProfilo) {
    const profilo = profiloFonte(nome, baseUrl);
    if (!profilo) {
      // Un profilo sconosciuto ferma le SUE leghe, non quelle degli altri.
      for (const lega of gruppo) {
        esiti.push({
          leagueId: lega.leagueId, leagueName: lega.leagueName,
          matchday: (lega.lastMatchday ?? 0) + 1,
          azione: 'errore' as const,
          motivo: `Profilo di fonte sconosciuto: "${nome}".`,
        });
      }
      continue;
    }

    try {
      const http = new FonteHttp({ profilo, ...(chiave ? { chiave } : {}) });
      const esito = await tickConsegne({
        store,
        fonte: creaFonteGiornata({ http, store, season }),
        leghe: gruppo,
        // La stagione decide quale diritto a pubblicare si controlla: pagare
        // il 2025-26 non apre il 2026-27.
        season,
        // Esplicita, non ereditata: e' la decisione che separa «giornata
        // finita» da «voti ancora in arrivo», e su questo percorso non la
        // guarda nessun umano prima della pubblicazione.
        policy: POLITICA_CRON,
        ignoraAttesa: forza,
        driver: driver(),
        fallback: new TemplateDriver(),
      });
      esiti.push(...esito.esiti);
      lettureGlobali += esito.lettureGlobali;
    } catch (e) {
      const motivo = e instanceof AdapterError
        ? e.message
        : e instanceof Error ? e.message : 'errore sconosciuto';
      for (const lega of gruppo) {
        esiti.push({
          leagueId: lega.leagueId, leagueName: lega.leagueName,
          matchday: (lega.lastMatchday ?? 0) + 1,
          azione: 'errore' as const, motivo,
        });
      }
    }
  }

  return Response.json(
    { esiti, lettureGlobali, leghe: leghe.length },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * LA STESSA COSA IN GET, perche' i cron delle piattaforme sanno fare solo
 * quello.
 *
 * Altrove in questo progetto una GET che cambia stato e' un difetto, e la
 * ragione e' precisa: una GET si attiva seguendo un collegamento qualunque,
 * quindi un'azione che apre sessioni o spende soldi puo' essere innescata da
 * un'immagine in una pagina altrui.
 *
 * Qui quella ragione non si applica, ed e' per questo che l'eccezione e'
 * accettabile invece che comoda: l'accesso e' autenticato da un segreto in
 * INTESTAZIONE, e una navigazione del browser le intestazioni non le imposta.
 * Un collegamento a questo indirizzo, cliccato da chiunque, riceve 401 come
 * qualunque altra richiesta senza segreto.
 */
export async function GET(req: Request): Promise<Response> {
  return POST(req);
}
