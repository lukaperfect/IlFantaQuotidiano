import { PERSONAS } from '@fantacomics/editorial';
import { renderPrintPage } from '@fantacomics/render';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';
const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

/** La versione broadsheet: stessa sorgente, impaginazione da stampa. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; matchday: string }> },
): Promise<Response> {
  const { slug, matchday } = await params;
  // L'indirizzo pubblico e' lo slug, non l'id interno: cosi' il link si revoca
  // rigenerandolo, senza toccare la lega.
  const config = await store.getConfigBySlug(slug);
  if (!config) return new Response('Edizione non trovata', { status: 404 });
  const published = await store.getEdition(config.leagueId, Number(matchday));
  if (!published) return new Response('Edizione non trovata', { status: 404 });

  return new Response(renderPrintPage(published.edition, published.pack, { personaNames }), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
