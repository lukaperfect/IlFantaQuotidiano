import { PERSONAS } from '@fantacomics/editorial';
import { renderWebPage } from '@fantacomics/render';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

/**
 * Il giornale servito come DOCUMENTO completo, non come pagina React.
 *
 * È già un documento autonomo con la sua tipografia: farlo passare da un
 * layout applicativo significherebbe duplicare gli stili e farli divergere.
 * L'app è il piano di controllo; il giornale è il prodotto.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; matchday: string }> },
): Promise<Response> {
  const { id, matchday } = await params;
  const n = Number(matchday);
  if (!Number.isInteger(n)) return new Response('Giornata non valida', { status: 400 });

  const published = await store.getEdition(id, n);
  if (!published) return new Response('Edizione non trovata', { status: 404 });

  const html = renderWebPage(published.edition, published.pack, { personaNames });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Un'edizione pubblicata è immutabile: si può cachare a lungo.
      'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
    },
  });
}
