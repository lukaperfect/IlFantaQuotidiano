import { z } from 'zod';
import { PREZZO_CENTESIMI, VALUTA } from './prezzo.js';

/**
 * IL POCO DI STRIPE CHE SERVE, SENZA SDK.
 *
 * Il prodotto fa UNA cosa sola: un pagamento una tantum per lega. Sono due
 * chiamate HTTP — creare una sessione di Checkout e leggere l'evento che
 * conferma il pagamento — piu' la verifica della firma, che sta a parte.
 *
 * `baseUrl` e' configurabile e non e' un dettaglio di comodo: da qui
 * `api.stripe.com` non e' raggiungibile, e un pagamento verificabile solo in
 * produzione e' un pagamento non verificato. Con l'indirizzo iniettabile la
 * catena intera — sessione, redirect, webhook firmato, attivazione — gira
 * contro uno Stripe finto e le stesse righe vanno poi su quello vero.
 */

export const STRIPE_BASE_PREDEFINITO = 'https://api.stripe.com';

export type OpzioniStripe = {
  chiave: string;
  baseUrl?: string;
  /** Iniettabile per le verifiche: di norma `fetch`. */
  fetchImpl?: typeof fetch;
};

export class ErroreStripe extends Error {
  constructor(message: string, readonly stato: number) {
    super(message);
    this.name = 'ErroreStripe';
  }
}

export type RichiestaCheckout = {
  leagueId: string;
  leagueName: string;
  season: string;
  /** Dove tornare dopo il pagamento. */
  successUrl: string;
  cancelUrl: string;
  /** Per la ricevuta. Non serve a identificare: quello lo fa `leagueId`. */
  email?: string;
};

export type SessioneCheckout = {
  id: string;
  url: string;
};

/**
 * Crea la sessione di pagamento.
 *
 * L'IMPORTO LO DECIDE IL SERVER, sempre. Un prezzo che arriva dal client e' un
 * prodotto gratis per chi sa aprire gli strumenti per sviluppatori, ed e' la
 * ragione per cui questa funzione non accetta nessun parametro di prezzo.
 *
 * `client_reference_id` porta la lega e la stagione: e' cio' che il webhook
 * usera' per sapere che cosa attivare. Torna indietro firmato, quindi e'
 * attendibile quanto la firma — ma si ricontrolla comunque che la lega esista.
 */
export async function creaSessioneCheckout(
  opzioni: OpzioniStripe,
  richiesta: RichiestaCheckout,
): Promise<SessioneCheckout> {
  const corpo = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': VALUTA,
    'line_items[0][price_data][unit_amount]': String(PREZZO_CENTESIMI),
    'line_items[0][price_data][product_data][name]':
      `FantaComics — ${richiesta.leagueName} (${richiesta.season})`,
    client_reference_id: riferimento(richiesta.leagueId, richiesta.season),
    'metadata[leagueId]': richiesta.leagueId,
    'metadata[season]': richiesta.season,
    success_url: richiesta.successUrl,
    cancel_url: richiesta.cancelUrl,
  });
  if (richiesta.email) corpo.set('customer_email', richiesta.email);

  const base = opzioni.baseUrl ?? STRIPE_BASE_PREDEFINITO;
  const chiamata = opzioni.fetchImpl ?? fetch;
  const risposta = await chiamata(`${base}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opzioni.chiave}`,
      'content-type': 'application/x-www-form-urlencoded',
      /**
       * IDEMPOTENZA. Un admin che ricarica la pagina o preme due volte non
       * deve poter aprire due pagamenti per la stessa lega e la stessa
       * stagione. La chiave e' deterministica su (lega, stagione): Stripe
       * restituisce la stessa sessione invece di crearne un'altra.
       */
      'idempotency-key': `fc-${riferimento(richiesta.leagueId, richiesta.season)}`,
    },
    body: corpo.toString(),
    signal: AbortSignal.timeout(20000),
  });

  const testo = await risposta.text();
  if (!risposta.ok) {
    // Il corpo di Stripe puo' contenere dettagli; l'importante e' non
    // rimandare mai la chiave, che sta nell'header e non nel corpo.
    throw new ErroreStripe(
      `Stripe ha rifiutato la creazione della sessione (${risposta.status}).`,
      risposta.status,
    );
  }

  const dati = SessioneSchema.safeParse(JSON.parse(testo));
  if (!dati.success) {
    throw new ErroreStripe('Risposta di Stripe senza id o url di sessione.', risposta.status);
  }
  return { id: dati.data.id, url: dati.data.url };
}

const SessioneSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
});

/** La chiave che lega un pagamento a una lega e a una stagione. */
export function riferimento(leagueId: string, season: string): string {
  return `${leagueId}:${season}`;
}

/* ------------------------------------------------------------------ *
 * L'evento
 * ------------------------------------------------------------------ */

/**
 * Lo SCHEMA DELL'EVENTO, ridotto a cio' che serve.
 *
 * Si valida invece di leggere i campi a fiducia: il corpo arriva da internet e
 * la firma dice che viene da Stripe, non che ha la forma attesa. Un campo
 * mancante deve diventare un rifiuto esplicito, non un `undefined` che scorre
 * fino a una lega attivata con una stagione «undefined».
 */
export const EventoStripeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      /** `paid` / `unpaid` / `no_payment_required`. */
      payment_status: z.string().optional(),
      amount_total: z.number().int().nullable().optional(),
      currency: z.string().nullable().optional(),
      client_reference_id: z.string().nullable().optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
      customer_email: z.string().nullable().optional(),
      customer_details: z.object({ email: z.string().nullable().optional() })
        .nullable().optional(),
    }),
  }),
});
export type EventoStripe = z.infer<typeof EventoStripeSchema>;

export type PagamentoRiconosciuto = {
  eventId: string;
  sessionId: string;
  leagueId: string;
  season: string;
  centesimi: number;
  valuta: string;
  email: string | null;
};

export type EsitoEvento =
  | { esito: 'pagamento'; pagamento: PagamentoRiconosciuto }
  | { esito: 'ignorato'; motivo: string }
  | { esito: 'rifiutato'; motivo: string };

/**
 * Che cosa dice questo evento.
 *
 * TRE ESITI E NON DUE. «Ignorato» e «rifiutato» sembrano la stessa cosa e non
 * lo sono: Stripe manda decine di tipi di evento e riceverne uno che non ci
 * riguarda e' normale — va risposto 200, altrimenti Stripe ritenta all'infinito
 * e alla fine disattiva l'endpoint. Un evento che ci riguarda ma non torna
 * invece e' un problema da far vedere.
 */
export function leggiEvento(grezzo: unknown, atteso: {
  centesimi?: number; valuta?: string;
} = {}): EsitoEvento {
  const letto = EventoStripeSchema.safeParse(grezzo);
  if (!letto.success) return { esito: 'rifiutato', motivo: 'Evento senza la forma attesa.' };

  const evento = letto.data;
  if (evento.type !== 'checkout.session.completed') {
    return { esito: 'ignorato', motivo: `Tipo non gestito: ${evento.type}.` };
  }

  const sessione = evento.data.object;
  if (sessione.payment_status !== 'paid') {
    // Una sessione completata ma non pagata esiste: non si attiva niente.
    return { esito: 'ignorato', motivo: `Sessione non pagata (${sessione.payment_status}).` };
  }

  const riferimento = sessione.client_reference_id
    ?? (sessione.metadata ? `${sessione.metadata.leagueId}:${sessione.metadata.season}` : null);
  if (!riferimento) {
    return { esito: 'rifiutato', motivo: 'Sessione senza riferimento alla lega.' };
  }
  const taglio = riferimento.lastIndexOf(':');
  const leagueId = taglio > 0 ? riferimento.slice(0, taglio) : '';
  const season = taglio > 0 ? riferimento.slice(taglio + 1) : '';
  if (leagueId === '' || !/^\d{4}-\d{2}$/.test(season)) {
    return { esito: 'rifiutato', motivo: `Riferimento illeggibile: "${riferimento}".` };
  }

  /**
   * SI CONTROLLA L'IMPORTO.
   *
   * Nessuno puo' creare una sessione senza la nostra chiave, quindi non e' una
   * difesa contro un attaccante: e' una difesa contro NOI STESSI. Un prezzo
   * cambiato in un posto e non nell'altro, o una sessione di prova arrivata in
   * produzione, attiverebbero una lega per un importo sbagliato senza che
   * nessuno se ne accorga mai.
   */
  const centesimi = sessione.amount_total ?? 0;
  const valuta = (sessione.currency ?? '').toLowerCase();
  const centesimiAttesi = atteso.centesimi ?? PREZZO_CENTESIMI;
  const valutaAttesa = (atteso.valuta ?? VALUTA).toLowerCase();
  if (centesimi !== centesimiAttesi || valuta !== valutaAttesa) {
    return {
      esito: 'rifiutato',
      motivo: `Importo inatteso: ${centesimi} ${valuta} invece di ${centesimiAttesi} ${valutaAttesa}.`,
    };
  }

  return {
    esito: 'pagamento',
    pagamento: {
      eventId: evento.id,
      sessionId: sessione.id,
      leagueId,
      season,
      centesimi,
      valuta,
      email: sessione.customer_details?.email ?? sessione.customer_email ?? null,
    },
  };
}
