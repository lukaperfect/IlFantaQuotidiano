import { redirect } from 'next/navigation';
import { consumeMagicLink } from '@fantacomics/auth';
import { authStore } from '@/lib/store';
import { startSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Consuma il magic link e apre la sessione.
 *
 * È una GET perché arriva da un click in un client di posta, ma è idempotente
 * solo in apparenza: il token è monouso, quindi un secondo passaggio (un
 * prefetch del client, un utente che ricarica) trova il link già speso e
 * riporta al login con un messaggio, invece di fallire in modo oscuro.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const esito = await consumeMagicLink(authStore, token);

  if (!esito.ok) {
    const motivo =
      esito.reason === 'scaduto' ? 'scaduto'
      : esito.reason === 'gia-usato' ? 'usato'
      : 'sconosciuto';
    redirect(`/accedi?errore=${motivo}`);
  }

  await startSession(esito.accountId);
  redirect('/');
}
