import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { consumeMagicLink, peekMagicLink } from '@fantacomics/auth';
import { authStore } from '@/lib/store';
import { startSession, NONCE_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

function motivoDi(reason: 'sconosciuto' | 'gia-usato' | 'scaduto'): string {
  return reason === 'scaduto' ? 'scaduto' : reason === 'gia-usato' ? 'usato' : 'sconosciuto';
}

/**
 * Apre il magic link.
 *
 * Due strade, e la differenza e' il punto di tutta la route.
 *
 * Se il browser porta il nonce messo al momento della richiesta, e' lo stesso
 * che ha chiesto l'accesso: si entra subito, senza attrito. E' il caso
 * normale, ed e' bene che resti a un click.
 *
 * Se non lo porta, il link e' arrivato altrove. Puo' essere legittimo — si
 * chiede da desktop e si apre dal telefono — ma puo' anche essere un link
 * inoltrato a qualcuno che non sa cosa sta aprendo. Aprire una sessione qui
 * significherebbe autenticare, con una GET, il browser di chi ha solo
 * seguito un collegamento: da quel momento in poi tutto cio' che quella
 * persona carica finisce nell'account di chi gliel'ha mandato, e lo fa
 * sull'origine vera, con il certificato vero e l'interfaccia vera — cioe'
 * senza nessuno dei segnali che rendono riconoscibile una truffa.
 *
 * Quindi non si apre niente: si passa dalla conferma, che mostra a schermo
 * in quale account si sta entrando. Chi ha chiesto il link riconosce il
 * proprio indirizzo e va avanti; chi non l'ha chiesto legge un indirizzo che
 * non e' il suo, che e' l'unica cosa che serve perche' si fermi.
 *
 * Il link NON viene consumato qui quando si passa dalla conferma: un token
 * speso per poter essere mostrato sarebbe gia' inutile alla riga dopo.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const jar = await cookies();
  const esito = await peekMagicLink(authStore, token, jar.get(NONCE_COOKIE)?.value);

  // Un secondo passaggio (il prefetch del client di posta, un utente che
  // ricarica) trova il link speso e torna al login con un messaggio, invece
  // di fallire in modo oscuro.
  if (!esito.ok) redirect(`/accedi?errore=${motivoDi(esito.reason)}`);

  if (!esito.stessoBrowser) redirect(`/accedi/${encodeURIComponent(token)}/conferma`);

  const consumato = await consumeMagicLink(authStore, token);
  if (!consumato.ok) redirect(`/accedi?errore=${motivoDi(consumato.reason)}`);

  await startSession(consumato.accountId);
  jar.delete(NONCE_COOKIE);
  redirect('/');
}
