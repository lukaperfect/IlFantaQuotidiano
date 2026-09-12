import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { peekMagicLink } from '@fantacomics/auth';
import { authStore } from '@/lib/store';
import { NONCE_COOKIE } from '@/lib/session';
import { confermaAccesso } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * Conferma di accesso da un dispositivo diverso da quello che ha chiesto il
 * link.
 *
 * L'unica cosa che questa pagina deve fare bene e' dire, grande e prima di
 * ogni altra cosa, IN QUALE ACCOUNT si sta per entrare. Chi ha chiesto il
 * link ci mette un secondo a riconoscere il proprio indirizzo; chi si e'
 * visto inoltrare il link di un altro legge un indirizzo che non conosce, ed
 * e' l'unico segnale che gli arriva — tutto il resto, dominio, certificato e
 * interfaccia, e' autentico.
 *
 * La pagina non consuma il link: se lo consumasse per potersi mostrare, il
 * bottone qui sotto aprirebbe su un token gia' speso.
 */
export default async function Conferma({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const jar = await cookies();
  const esito = await peekMagicLink(authStore, token, jar.get(NONCE_COOKIE)?.value);

  if (!esito.ok) {
    const motivo =
      esito.reason === 'scaduto' ? 'scaduto'
      : esito.reason === 'gia-usato' ? 'usato'
      : 'sconosciuto';
    redirect(`/accedi?errore=${motivo}`);
  }

  const account = await authStore.getAccount(esito.accountId);
  if (!account) redirect('/accedi?errore=sconosciuto');

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker"><Link href="/">FantaComics</Link></p>
        <h1>Confermi l&rsquo;accesso?</h1>
      </header>

      <p className="muted">
        Questo link è stato chiesto da un altro dispositivo o da un altro
        browser. Stai per entrare nell&rsquo;account:
      </p>

      <p className="account-conferma">{account.email}</p>

      <p className="notice">
        Se non riconosci questo indirizzo, <strong>chiudi questa pagina</strong>:
        qualcuno ti ha girato il proprio link di accesso, e quello che
        caricheresti da qui finirebbe nel suo archivio, non nel tuo.
      </p>

      <form action={confermaAccesso.bind(null, token)}>
        <button className="btn btn--primary" type="submit">Sono io, entra</button>
      </form>

      <p className="muted small" style={{ marginTop: 18 }}>
        <Link href="/accedi">Preferisco ricevere un link mio</Link>
      </p>
    </main>
  );
}
