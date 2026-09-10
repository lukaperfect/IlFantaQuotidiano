import { renderCardSvg, type CardFormat } from '@fantacomics/render';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * La card come immagine.
 *
 * È il formato che decide il coefficiente virale: quando il link finisce nel
 * gruppo, l'anteprima deve GIÀ essere lo sfottò. Chi non clicca ride lo
 * stesso, e chi ride clicca.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; matchday: string; teamId: string }> },
): Promise<Response> {
  const { slug, matchday, teamId } = await params;
  const config = await store.getConfigBySlug(slug);
  if (!config) return new Response('Edizione non trovata', { status: 404 });

  const published = await store.getEdition(config.leagueId, Number(matchday));
  if (!published) return new Response('Edizione non trovata', { status: 404 });

  const card = published.edition.personalCards.find((c) => c.teamId === teamId);
  if (!card) return new Response('Card non trovata', { status: 404 });

  const requested = new URL(request.url).searchParams.get('formato');
  const format: CardFormat =
    requested === 'story' ? 'story' : requested === 'og' ? 'og' : 'feed';

  const svg = renderCardSvg({
    teamName: card.teamName,
    headline: card.headline,
    body: card.body,
    statLabel: card.stat.label,
    statValue: card.stat.value,
    tone: card.tone,
    matchday: published.edition.meta.matchday,
    leagueName: published.edition.meta.leagueName,
  }, format);

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      /**
       * Nessuna cache condivisa.
       *
       * L'indirizzo e' un segreto revocabile: se la risposta resta in una
       * cache per minuti od ore, rigenerare lo slug NON revoca niente per
       * chi quel link lo ha gia' aperto, e la funzione di revoca diventa
       * una bugia. Il costo e' modesto — la pagina si compone da un JSON —
       * e la correttezza qui vale molto piu' della banda risparmiata.
       */
      'cache-control': 'no-store',
    },
  });
}
