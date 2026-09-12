import type { EditionKind } from '@fantacomics/core';
import { PERSONAS } from '@fantacomics/editorial';
import { renderWebPage } from '@fantacomics/render';
import { edizioneLeggibile } from '@fantacomics/pipeline';
import { store } from '@/lib/store';

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

/**
 * SERVIRE UN NUMERO DEL GIORNALE.
 *
 * Sta in una funzione sola perche' i numeri sono due — la vigilia e il
 * retrospettivo — e le garanzie da rispettare sono le stesse per entrambi:
 * indirizzo pubblico che e' uno slug revocabile, 404 indistinguibile fra lega
 * altrui, edizione assente ed edizione sotto soglia, nessuna cache condivisa.
 * Duplicare la funzione per il secondo tipo avrebbe significato duplicare
 * quelle quattro garanzie, e il modo in cui si perdono e' che una delle due
 * copie non venga aggiornata.
 */
export async function serviGiornale(
  slug: string,
  matchday: string,
  kind: EditionKind,
): Promise<Response> {
  // L'indirizzo pubblico e' lo slug, non l'id interno: cosi' il link si revoca
  // rigenerandolo, senza toccare la lega.
  const config = await store.getConfigBySlug(slug);
  if (!config) return new Response('Edizione non trovata', { status: 404 });
  const n = Number(matchday);
  if (!Number.isInteger(n)) return new Response('Giornata non valida', { status: 400 });

  const published = await store.getEdition(config.leagueId, n, kind);
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
       * Fuori dai motori di ricerca.
       *
       * Sta nell'header e non solo nel `<meta>` perche' le immagini e i PDF
       * non hanno un head in cui metterlo, e perche' l'header vale anche per
       * chi scarica il file senza renderizzarlo.
       */
      'x-robots-tag': 'noindex, nofollow, noarchive',
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
