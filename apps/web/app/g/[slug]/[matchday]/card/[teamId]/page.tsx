import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { store } from '@/lib/store';
import { edizioneLeggibile } from '@fantacomics/pipeline';
import { ShareButton } from './share';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; matchday: string; teamId: string }> };

/**
 * L'anteprima del link È il prodotto.
 * Quando la card finisce nel gruppo, chi non apre deve comunque leggere lo
 * sfottò: e' quello che genera il click, non il titolo della pagina.
 */
/** L'indirizzo e' un segreto revocabile: un motore che lo indicizza lo rende eterno. */
const SENZA_INDICE = { index: false, follow: false, nocache: true } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, matchday, teamId } = await params;
  const config = await store.getConfigBySlug(slug);
  const published = config ? await store.getEdition(config.leagueId, Number(matchday)) : null;
  const card = published?.edition.personalCards.find((c) => c.teamId === teamId);
  if (!card) return { title: 'FantaComics', robots: SENZA_INDICE };

  const img = `/g/${slug}/${matchday}/card/${teamId}/img?formato=og`;
  return {
    title: `${card.teamName} · ${card.headline}`,
    description: card.body,
    openGraph: {
      title: `${card.teamName} · ${card.headline}`,
      description: card.body,
      images: [{ url: img, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', images: [img] },
    /**
     * L'anteprima nel gruppo si', l'indicizzazione no.
     *
     * Sono due cose diverse e vanno tenute separate: i tag OpenGraph servono
     * a chi riceve il link in chat, il `noindex` a chi il link non dovrebbe
     * averlo mai visto. Rinunciare ai primi per ottenere il secondo
     * spegnerebbe proprio la feature che moltiplica la condivisione.
     */
    robots: SENZA_INDICE,
  };
}

export default async function CardPage({ params }: Props) {
  const { slug, matchday, teamId } = await params;
  const config = await store.getConfigBySlug(slug);
  if (!config) notFound();

  const published = await store.getEdition(config.leagueId, Number(matchday));
  if (!published) notFound();
  /**
   * Sotto soglia non si serve, e si risponde come a un'edizione che non c'e'.
   *
   * La confidenza veniva calcolata e poi ignorata da OGNI percorso di lettura:
   * un'edizione con riconciliazione fallita finiva nel gruppo esattamente come
   * una buona, e "meglio nessun giornale che un giornale sbagliato" era una
   * frase senza codice sotto. Il 404 e' lo stesso di una lega altrui: chi ha
   * il link non deve nemmeno sapere che esiste una bozza.
   */
  if (!edizioneLeggibile(published)) notFound();

  const card = published.edition.personalCards.find((c) => c.teamId === teamId);
  if (!card) notFound();

  const others = published.edition.personalCards.filter((c) => c.teamId !== teamId);
  const imgBase = `/g/${slug}/${matchday}/card/${teamId}/img`;

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker">
          <Link href={`/g/${slug}/${matchday}`}>Giornata {matchday}</Link> · Card personale
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
        <Link className="btn" href={`/g/${slug}/${matchday}`}>Leggi il giornale</Link>
      </div>

      {others.length > 0 ? (
        <>
          <h2>Le altre card</h2>
          <ul className="card-list">
            {others.map((c) => (
              <li key={c.teamId} className="item">
                <span><strong>{c.teamName}</strong></span>
                <Link className="btn" href={`/g/${slug}/${matchday}/card/${c.teamId}`}>Apri</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
