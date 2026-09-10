import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { store } from '@/lib/store';
import { ShareButton } from './share';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string; matchday: string; teamId: string }> };

/**
 * L'anteprima del link È il prodotto.
 * Quando la card finisce nel gruppo, chi non apre deve comunque leggere lo
 * sfottò: e' quello che genera il click, non il titolo della pagina.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, matchday, teamId } = await params;
  const published = await store.getEdition(id, Number(matchday));
  const card = published?.edition.personalCards.find((c) => c.teamId === teamId);
  if (!card) return { title: 'FantaComics' };

  const img = `/g/${id}/${matchday}/card/${teamId}/img?formato=og`;
  return {
    title: `${card.teamName} · ${card.headline}`,
    description: card.body,
    openGraph: {
      title: `${card.teamName} · ${card.headline}`,
      description: card.body,
      images: [{ url: img, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', images: [img] },
  };
}

export default async function CardPage({ params }: Props) {
  const { id, matchday, teamId } = await params;
  const published = await store.getEdition(id, Number(matchday));
  if (!published) notFound();

  const card = published.edition.personalCards.find((c) => c.teamId === teamId);
  if (!card) notFound();

  const others = published.edition.personalCards.filter((c) => c.teamId !== teamId);
  const imgBase = `/g/${id}/${matchday}/card/${teamId}/img`;

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker">
          <Link href={`/g/${id}/${matchday}`}>Giornata {matchday}</Link> · Card personale
        </p>
        <h1>{card.teamName}</h1>
      </header>

      <img
        src={imgBase}
        alt={card.headline}
        style={{ width: '100%', maxWidth: 460, border: '1px solid var(--rule)', display: 'block' }}
      />

      <div className="row" style={{ marginTop: 18 }}>
        <ShareButton title={`${card.teamName} · ${card.headline}`} text={card.body} />
        <a className="btn" href={`${imgBase}?formato=story`} download={`${card.teamName}-story.svg`}>
          Formato storia
        </a>
        <Link className="btn" href={`/g/${id}/${matchday}`}>Leggi il giornale</Link>
      </div>

      {others.length > 0 ? (
        <>
          <h2>Le altre card</h2>
          <ul className="card-list">
            {others.map((c) => (
              <li key={c.teamId} className="item">
                <span><strong>{c.teamName}</strong></span>
                <Link className="btn" href={`/g/${id}/${matchday}/card/${c.teamId}`}>Apri</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
