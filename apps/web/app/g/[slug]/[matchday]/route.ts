import { PERSONAS } from '@fantacomics/editorial';
import { renderWebPage } from '@fantacomics/render';
import { store } from '@/lib/store';
import { edizioneLeggibile } from '@fantacomics/pipeline';

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
  { params }: { params: Promise<{ slug: string; matchday: string }> },
): Promise<Response> {
  const { slug, matchday } = await params;
  // L'indirizzo pubblico e' lo slug, non l'id interno: cosi' il link si revoca
  // rigenerandolo, senza toccare la lega.
  const config = await store.getConfigBySlug(slug);
  if (!config) return new Response('Edizione non trovata', { status: 404 });
  const n = Number(matchday);
  if (!Number.isInteger(n)) return new Response('Giornata non valida', { status: 400 });

  const published = await store.getEdition(config.leagueId, n);
  if (!published) return new Response('Edizione non trovata', { status: 404 });
  /**
   * Sotto soglia non si serve, e si risponde come a un'edizione che non c'e'.
   *
   * La confidenza veniva calcolata e poi ignorata da OGNI percorso di lettura:
   * un'edizione con riconciliazione fallita finiva nel gruppo esattamente come
   * una buona, e "meglio nessun giornale che un giornale sbagliato" era una
   * frase senza codice sotto. Il 404 e' lo stesso di una lega altrui: chi ha
   * il link non deve nemmeno sapere che esiste una bozza.
   */
  if (!edizioneLeggibile(published)) {
    return new Response('Edizione non trovata', { status: 404 });
  }

  const html = renderWebPage(published.edition, published.pack, { personaNames });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
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
