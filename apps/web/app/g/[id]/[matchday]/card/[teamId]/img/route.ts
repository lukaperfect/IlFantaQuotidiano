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
  { params }: { params: Promise<{ id: string; matchday: string; teamId: string }> },
): Promise<Response> {
  const { id, matchday, teamId } = await params;
  const published = await store.getEdition(id, Number(matchday));
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
      'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
    },
  });
}
