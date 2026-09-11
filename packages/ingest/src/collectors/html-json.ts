/**
 * IL JSON DENTRO L'HTML.
 *
 * Una pagina di un sito moderno e' HTML, ma i dati che mostra quasi sempre
 * viaggiano come JSON dentro quell'HTML: `__NEXT_DATA__`, un tag
 * `application/json`, o un'assegnazione a una variabile globale. Chi legge la
 * pagina come testo conclude «non si puo' fare» mentre i dati erano li' sotto.
 *
 * NON E' UN ANALIZZATORE DI HTML, ed e' una scelta. Un parser vero sarebbe
 * migliaia di righe e una superficie d'attacco larga su input non fidato; qui
 * serve trovare dei blocchi delimitati in modo molto preciso, e una ricerca
 * mirata fa esattamente quello. Se un giorno servisse navigare il DOM, allora
 * servirebbe un parser vero — e sarebbe un'altra decisione.
 *
 * Sta nel pacchetto e non dentro lo script dell'ispettore perche' lo usano in
 * due: l'ispettore per capire dove sono i dati, e la fonte HTTP per leggerli
 * davvero. Due copie divergerebbero il giorno in cui una delle due impara un
 * caso nuovo, e l'ispettore direbbe «ho trovato» su qualcosa che la fonte poi
 * non trova.
 */

export type BloccoJson = {
  /** Dove stava, in forma leggibile: serve nei messaggi e nella diagnostica. */
  dove: string;
  /** Un identificatore quando c'e' (`__NEXT_DATA__` e simili). */
  id: string | null;
  byte: number;
  valore: unknown;
};

/** Quanto HTML si accetta di analizzare: oltre, e' quasi certo un guasto. */
const MAX_BYTE_HTML = 8 * 1024 * 1024;

export function jsonDentroHtml(html: string): BloccoJson[] {
  if (html.length > MAX_BYTE_HTML) return [];
  const out: BloccoJson[] = [];

  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributi = m[1] ?? '';
    const contenuto = (m[2] ?? '').trim();
    if (contenuto === '') continue;

    const id = /id=["']([^"']+)["']/i.exec(attributi)?.[1] ?? null;
    const tipo = /type=["']([^"']+)["']/i.exec(attributi)?.[1] ?? '';

    if (/json/i.test(tipo)) {
      try {
        out.push({
          dove: id ? `<script id="${id}">` : `<script type="${tipo}">`,
          id,
          byte: contenuto.length,
          valore: JSON.parse(contenuto),
        });
      } catch { /* un tag json malformato non aiuta nessuno: si salta */ }
      continue;
    }

    // `window.__QUALCOSA = { ... };` oppure `var dati = [ ... ];`
    const assegnazione =
      /(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/.exec(contenuto);
    if (assegnazione) {
      try {
        out.push({
          dove: `script: ${assegnazione[1]}`,
          id: assegnazione[1] ?? null,
          byte: (assegnazione[2] ?? '').length,
          // Spesso e' JavaScript e non JSON — funzioni, virgolette singole,
          // virgole finali. In quel caso si salta senza rumore: non e' un
          // guasto, e' solo uno script qualunque.
          valore: JSON.parse(assegnazione[2] as string),
        });
      } catch { /* JavaScript, non JSON */ }
    }
  }
  return out;
}

/**
 * Il blocco da usare: quello con l'id chiesto, altrimenti il piu' grande.
 *
 * Il piu' grande e' quasi sempre quello con i dati veri — gli altri sono
 * configurazione, tracciamento, dati strutturati per i motori di ricerca. E'
 * un'euristica e va detto: per questo l'id si puo' sempre dichiarare nel
 * profilo, e quando c'e' vince.
 */
export function scegliBlocco(blocchi: readonly BloccoJson[], id?: string): BloccoJson | null {
  if (blocchi.length === 0) return null;
  if (id) return blocchi.find((b) => b.id === id) ?? null;
  return blocchi.reduce((a, b) => (b.byte > a.byte ? b : a));
}
