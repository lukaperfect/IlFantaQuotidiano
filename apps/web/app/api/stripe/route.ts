import { leggiEvento, verificaFirmaStripe } from '@fantacomics/billing';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * IL WEBHOOK DI STRIPE: e' qui che una lega diventa attiva.
 *
 * L'unica cosa che separa «hanno pagato» da «qualcuno ha fatto una POST» e' la
 * firma. Senza, chiunque conosca questo indirizzo attiva le leghe che vuole — e
 * non sarebbe una fuga di dati, sarebbe il prodotto regalato.
 *
 * TRE REGOLE CHE SEMBRANO DETTAGLI E NON LO SONO:
 *
 * 1. Si legge il corpo GREZZO, mai il JSON gia' analizzato. La firma copre i
 *    byte esatti: riserializzare un oggetto cambia spazi e ordine dei campi, e
 *    la verifica fallirebbe su richieste perfettamente valide.
 * 2. Un evento che non ci riguarda riceve 200, non un errore. Stripe manda
 *    decine di tipi; rispondere male lo fa ritentare all'infinito e alla fine
 *    disattiva l'endpoint — cioe' i pagamenti veri smettono di arrivare.
 * 3. Una riconsegna dello stesso evento riceve 200. E' la garanzia «almeno una
 *    volta» di Stripe, non un guasto.
 */
export async function POST(req: Request): Promise<Response> {
  const segreto = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  /**
   * Senza segreto l'endpoint e' CHIUSO, non aperto: il valore predefinito di
   * una porta e' chiusa, e questa porta vale il prezzo del prodotto.
   *
   * E' una difesa RIDONDANTE, di proposito: `verificaFirmaStripe` rifiuta gia'
   * qualunque cosa quando il segreto e' vuoto, ed e' verificato a parte. Qui si
   * risponde 503 invece di 400 perche' i due casi sono diversi per chi
   * amministra — «non ho un segreto» e' un errore di configurazione, non una
   * richiesta malfatta — ma il prodotto non dipende da questo ramo.
   */
  if (segreto === '') {
    return Response.json({ errore: 'non configurato' }, { status: 503 });
  }

  const corpo = await req.text();
  const firma = req.headers.get('stripe-signature') ?? '';
  const esitoFirma = verificaFirmaStripe({ corpo, header: firma, segreto });
  if (!esitoFirma.ok) {
    /**
     * Il motivo NON torna al chiamante.
     *
     * «Firma fuori tolleranza» e «nessuna firma corrisponde» sono informazioni
     * utili a chi sta provando a forgiare richieste: dicono se il timestamp era
     * accettabile, cioe' su cosa lavorare. Nei log si scrive per intero, nella
     * risposta no.
     */
    console.warn(`[stripe] firma rifiutata: ${esitoFirma.motivo}`);
    return Response.json({ errore: 'firma non valida' }, { status: 400 });
  }

  let grezzo: unknown;
  try {
    grezzo = JSON.parse(corpo);
  } catch {
    return Response.json({ errore: 'corpo non JSON' }, { status: 400 });
  }

  const letto = leggiEvento(grezzo);
  if (letto.esito === 'ignorato') {
    return Response.json({ ok: true, nota: letto.motivo }, { status: 200 });
  }
  if (letto.esito === 'rifiutato') {
    console.warn(`[stripe] evento rifiutato: ${letto.motivo}`);
    return Response.json({ errore: 'evento non utilizzabile' }, { status: 400 });
  }

  const p = letto.pagamento;

  /**
   * SI CONTROLLA CHE LA LEGA ESISTA.
   *
   * Il riferimento arriva firmato, quindi viene davvero da Stripe — ma «viene
   * da Stripe» non vuol dire «e' una nostra lega»: una sessione creata a mano
   * dalla dashboard, o un id rimasto da una lega cancellata, creerebbero un
   * diritto appeso a niente. Un pagamento per una lega inesistente e' un
   * rimborso da fare, e va visto nei log invece di restare una riga orfana.
   */
  if (!(await store.esisteLega(p.leagueId))) {
    console.warn(`[stripe] pagamento per una lega inesistente: ${p.leagueId}`);
    return Response.json({ ok: true, nota: 'lega sconosciuta' }, { status: 200 });
  }

  const registrato = await store.saveEntitlement({
    leagueId: p.leagueId,
    season: p.season,
    paidAt: new Date().toISOString(),
    eventId: p.eventId,
    sessionId: p.sessionId,
    amountCents: p.centesimi,
    currency: p.valuta,
  });

  console.log(
    `[stripe] ${registrato ? 'lega attivata' : 'evento gia visto'}: `
    + `${p.leagueId} stagione ${p.season}`,
  );
  return Response.json({ ok: true, registrato }, { status: 200 });
}
