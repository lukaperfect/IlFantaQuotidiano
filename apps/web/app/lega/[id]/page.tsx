import Link from 'next/link';
import { notFound } from 'next/navigation';
import { store } from '@/lib/store';
import { ConfigForm } from './config-form';

export const dynamic = 'force-dynamic';

export default async function Lega({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const config = await store.getConfig(id);
  if (!config) notFound();

  const matchdays = await store.listEditions(id);
  const editions = await Promise.all(
    matchdays.map(async (n) => {
      const published = await store.getEdition(id, n);
      return { n, edition: published?.edition ?? null };
    }),
  );

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
                <Link className="btn" href={`/g/${id}/${n}`}>Leggi</Link>
                {edition?.personalCards[0] ? (
                  <Link className="btn" href={`/g/${id}/${n}/card/${edition.personalCards[0].teamId}`}>
                    Card
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Regolamento</h2>
      <p className="muted small">
        Il regolamento è un dato, non un’assunzione: se non corrisponde a quello
        della tua lega i punteggi non riconcilieranno e le analisi si spegneranno
        da sole invece di raccontare numeri sbagliati.
      </p>
      <ConfigForm config={config} />

      <p className="muted small" style={{ marginTop: 24 }}>
        Regolamento versione {config.ruleset.version} · lega creata il{' '}
        {new Date(config.createdAt).toLocaleDateString('it-IT')}
      </p>
    </main>
  );
}
