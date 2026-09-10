import { PERSONAS } from '@fantacomics/editorial';
import { renderPrintPage } from '@fantacomics/render';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';
const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

/** La versione broadsheet: stessa sorgente, impaginazione da stampa. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; matchday: string }> },
): Promise<Response> {
  const { id, matchday } = await params;
  const published = await store.getEdition(id, Number(matchday));
  if (!published) return new Response('Edizione non trovata', { status: 404 });

  return new Response(renderPrintPage(published.edition, published.pack, { personaNames }), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
