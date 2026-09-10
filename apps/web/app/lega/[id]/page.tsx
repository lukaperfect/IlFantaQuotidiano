import Link from 'next/link';
import { notFound } from 'next/navigation';
import { store } from '@/lib/store';
import { requireAccount } from '@/lib/session';
import { rigeneraLink } from '@/app/actions';
import { ConfigForm } from './config-form';

export const dynamic = 'force-dynamic';

export default async function Lega({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount();

  // Lega altrui e lega inesistente arrivano entrambe qui: lo store non
  // distingue i due casi, e nemmeno la pagina.
  const config = await store.getConfigForOwner(id, account.accountId);
  if (!config) notFound();

  const matchdays = await store.listEditions(id);
  const editions = await Promise.all(
    matchdays.map(async (n) => {
      const published = await store.getEdition(id, n);
      return { n, edition: published?.edition ?? null };
    }),
  );

  const base = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
  const ultima = config.lastMatchday;

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker"><Link href="/">FantaComics</Link> · Lega</p>
        <h1>{config.leagueName}</h1>
      </header>

      <h2>Edizioni</h2>
      {editions.length === 0 ? (
        <p className="muted">Nessuna edizione ancora pubblicata.</p>
      ) : (
        <ul className="card-list">
          {editions.map(({ n, edition }) => (
            <li key={n} className="item">
              <span>
                <strong>Giornata {n}</strong>
                <br />
                <span className="muted small">
                  {edition
                    ? `${edition.articles.length} pezzi · confidenza ${edition.meta.confidence.toFixed(2)}`
                    : '—'}
                  {edition?.meta.degraded ? ' · edizione ridotta' : ''}
                  {edition && edition.meta.confidence < 0.6 ? ' · in revisione' : ''}
                </span>
              </span>
              <span className="row">
                <Link className="btn" href={`/g/${config.publicSlug}/${n}`}>Leggi</Link>
                {edition?.personalCards[0] ? (
                  <Link
                    className="btn"
                    href={`/g/${config.publicSlug}/${n}/card/${edition.personalCards[0].teamId}`}
                  >
                    Card
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Link da condividere</h2>
      <p className="muted small">
        Il giornale si legge senza account: è così che gira nel gruppo. L’indirizzo
        è un segreto lungo e separato dall’identità della lega, quindi se finisce
        dove non doveva puoi rigenerarlo e il vecchio smette di funzionare.
      </p>
      <div className="share-box">
        <code>{ultima ? `${base}/g/${config.publicSlug}/${ultima}` : `${base}/g/${config.publicSlug}/…`}</code>
        <form action={rigeneraLink}>
          <input type="hidden" name="leagueId" value={config.leagueId} />
          <button className="btn" type="submit">Rigenera il link (revoca il precedente)</button>
        </form>
      </div>

      <h2>Regolamento</h2>
      <p className="muted small">
        Il regolamento è un dato, non un’assunzione: se non corrisponde a quello
        della tua lega i punteggi non riconcilieranno e le analisi si spegneranno
        da sole invece di raccontare numeri sbagliati.
      </p>
      <ConfigForm config={config} />

      <footer className="colophon-row">
        <span className="muted small">
          Regolamento versione {config.ruleset.version} · creata il{' '}
          {new Date(config.createdAt).toLocaleDateString('it-IT')}
        </span>
        <form action="/esci" method="post">
          <button className="btn" type="submit">Esci</button>
        </form>
      </footer>
    </main>
  );
}
