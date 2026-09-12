import Link from 'next/link';
import { Legale } from '@/app/legale';
import { currentAccount } from '@/lib/session';
import { redirect } from 'next/navigation';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

const MOTIVI: Record<string, string> = {
  scaduto: 'Quel link è scaduto: ne servono uno nuovo.',
  usato: 'Quel link era già stato usato. Richiedine un altro.',
  sconosciuto: 'Link non riconosciuto. Richiedine uno nuovo.',
};

export default async function Accedi({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentAccount()) redirect('/');
  const errore = String((await searchParams).errore ?? '');

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker"><Link href="/">FantaComics</Link></p>
        <h1>Accedi</h1>
      </header>

      {MOTIVI[errore] ? <p className="notice error">{MOTIVI[errore]}</p> : null}

      <p className="muted">
        Nessuna password. Inserisci la tua email e ricevi un link di accesso
        valido quindici minuti, utilizzabile una volta sola.
      </p>

      <LoginForm />

      <footer className="colophon-row"><Legale /></footer>
    </main>
  );
}
