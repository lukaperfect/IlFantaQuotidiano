import { PERSONAS } from '@fantacomics/editorial';
import { renderWebPage } from '@fantacomics/render';
import { store } from '@/lib/store';
import { currentAccount } from '@/lib/session';

export const dynamic = 'force-dynamic';

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

/**
 * L'anteprima per il proprietario.
 *
 * Un'edizione sotto soglia non si serve al pubblico, ma qualcuno deve pur
 * poterla guardare per decidere: una coda di revisione che non si puo'
 * leggere non e' una coda, e' un cestino.
 *
 * L'indirizzo passa dall'id interno e dalla sessione, NON dallo slug
 * pubblico: e' l'unica differenza che conta, perche' lo slug e' un segreto
 * condiviso e questa pagina non deve poterla aprire chi ha ricevuto il link
 * nel gruppo.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; matchday: string }> },
): Promise<Response> {
  const account = await currentAccount();
  if (!account) return new Response('Non trovata', { status: 404 });

  const { id, matchday } = await params;
  // Lega altrui e lega inesistente rispondono identicamente, come ovunque.
  const config = await store.getConfigForOwner(id, account.accountId);
  if (!config) return new Response('Non trovata', { status: 404 });

  const n = Number(matchday);
  if (!Number.isInteger(n)) return new Response('Giornata non valida', { status: 400 });

  const published = await store.getEdition(config.leagueId, n);
  if (!published) return new Response('Non trovata', { status: 404 });

  const html = renderWebPage(published.edition, published.pack, { personaNames });
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
