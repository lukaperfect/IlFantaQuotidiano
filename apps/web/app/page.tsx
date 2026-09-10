import Link from 'next/link';
import { store } from '@/lib/store';
import { requireAccount } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const account = await requireAccount();
  const leagues = await store.listLeagues(account.accountId);

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker">Il giornale della tua lega</p>
        <h1>FantaComics</h1>
      </header>

      {leagues.length === 0 ? (
        <>
          <p>
            Ogni giornata, un vero quotidiano sportivo scritto su misura per la tua lega:
            analisi, sfottò e una card personale per ciascun presidente.
          </p>
          <p className="muted small">
            Nessuna lega collegata. Puoi partire da una lega di prova con dati generati,
            oppure caricare i CSV esportati dalla tua piattaforma.
          </p>
        </>
      ) : (
        <ul className="card-list">
          {leagues.map((l) => (
            <li key={l.leagueId} className="item">
              <span>
                <strong>{l.leagueName}</strong>
                <br />
                <span className="muted small">
                  {l.lastMatchday
                    ? `Ultima edizione: giornata ${l.lastMatchday}`
                    : 'Nessuna edizione ancora'}
                </span>
              </span>
              <Link className="btn" href={`/lega/${l.leagueId}`}>Apri</Link>
            </li>
          ))}
        </ul>
      )}

      <div className="row" style={{ marginTop: 28 }}>
        <Link className="btn btn--primary" href="/lega/nuova">Collega una lega</Link>
      </div>

      <footer className="colophon-row">
        <span className="muted small">{account.email}</span>
        <form action="/esci" method="post">
          <button className="btn" type="submit">Esci</button>
        </form>
      </footer>
    </main>
  );
}
