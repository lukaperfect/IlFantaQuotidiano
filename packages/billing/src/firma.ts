import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LA FIRMA DEL WEBHOOK.
 *
 * E' l'unico controllo che separa «Stripe dice che hanno pagato» da «qualcuno
 * ha fatto una POST al nostro endpoint». Senza, chiunque conosca l'indirizzo
 * attiva le leghe che vuole: non e' una fuga di dati, e' il prodotto regalato.
 *
 * PERCHE' A MANO E NON CON L'SDK. Il calcolo e' un HMAC-SHA256 su
 * «timestamp.corpo», cioe' quindici righe. L'SDK di Stripe porta con se' un
 * albero di dipendenze e una superficie molto piu' larga per un endpoint che
 * riceve richieste da internet. Le stesse ragioni del lettore xlsx scritto in
 * casa: la parte che tocca input non fidato e' la parte che si vuole piccola e
 * leggibile per intero.
 *
 * Formato dell'header `Stripe-Signature`:
 *
 *     t=1699999999,v1=<hex>,v1=<hex>
 *
 * Le v1 possono essere piu' d'una durante la rotazione del segreto: basta che
 * UNA corrisponda. Le versioni sconosciute (v0 e simili) si ignorano invece di
 * far fallire, altrimenti una versione nuova romperebbe l'endpoint.
 */

export type EsitoFirma =
  | { ok: true }
  | { ok: false; motivo: string };

/**
 * Quanto puo' essere vecchia una firma. Cinque minuti e' il valore che Stripe
 * stesso consiglia: senza questo controllo una richiesta valida catturata una
 * volta resta valida per sempre, ed e' un replay che nessuna firma ferma.
 */
export const TOLLERANZA_SECONDI = 300;

function confrontaEsadecimali(a: string, b: string): boolean {
  // Due buffer di lunghezza diversa fanno lanciare timingSafeEqual, e
  // confrontarli con === perderebbe per definizione la proprieta' cercata.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verificaFirmaStripe(opzioni: {
  /** Il corpo GREZZO, byte per byte come e' arrivato. */
  corpo: string;
  /** Il valore dell'header `Stripe-Signature`. */
  header: string;
  segreto: string;
  /** Adesso, in secondi. Iniettabile per poter provare il replay. */
  adessoSecondi?: number;
  tolleranzaSecondi?: number;
}): EsitoFirma {
  const { corpo, header, segreto } = opzioni;
  if (segreto === '') return { ok: false, motivo: 'Nessun segreto configurato.' };
  if (header === '') return { ok: false, motivo: 'Header di firma assente.' };

  let timestamp: string | null = null;
  const firme: string[] = [];
  for (const pezzo of header.split(',')) {
    const taglio = pezzo.indexOf('=');
    if (taglio < 0) continue;
    const chiave = pezzo.slice(0, taglio).trim();
    const valore = pezzo.slice(taglio + 1).trim();
    if (chiave === 't') timestamp = valore;
    else if (chiave === 'v1') firme.push(valore);
  }

  if (timestamp === null) return { ok: false, motivo: 'Header senza timestamp.' };
  if (firme.length === 0) return { ok: false, motivo: 'Header senza firme v1.' };

  const t = Number(timestamp);
  if (!Number.isFinite(t)) return { ok: false, motivo: 'Timestamp non numerico.' };

  const adesso = opzioni.adessoSecondi ?? Math.floor(Date.now() / 1000);
  const tolleranza = opzioni.tolleranzaSecondi ?? TOLLERANZA_SECONDI;
  /**
   * Si controlla lo scarto in VALORE ASSOLUTO.
   *
   * Solo «troppo vecchia» lascerebbe passare un timestamp nel futuro, e un
   * orologio sfasato in avanti sull'altro lato renderebbe una firma valida per
   * ore dopo che dovrebbe essere scaduta.
   */
  if (Math.abs(adesso - t) > tolleranza) {
    return { ok: false, motivo: `Firma fuori tolleranza (${Math.abs(adesso - t)}s).` };
  }

  const atteso = createHmac('sha256', segreto).update(`${timestamp}.${corpo}`).digest('hex');
  // UNA firma valida basta: durante la rotazione del segreto Stripe ne manda due.
  if (firme.some((f) => confrontaEsadecimali(f, atteso))) return { ok: true };
  return { ok: false, motivo: 'Nessuna firma corrisponde.' };
}

/**
 * Firma un corpo come farebbe Stripe. Serve alle verifiche: senza, l'unico
 * modo di provare l'endpoint sarebbe disattivare il controllo, cioe' provare
 * qualcos'altro.
 */
export function firmaComeStripe(
  corpo: string, segreto: string, adessoSecondi = Math.floor(Date.now() / 1000),
): string {
  const firma = createHmac('sha256', segreto).update(`${adessoSecondi}.${corpo}`).digest('hex');
  return `t=${adessoSecondi},v1=${firma}`;
}
