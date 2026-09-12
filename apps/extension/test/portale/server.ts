/**
 * IL PORTALE DI PROVA.
 *
 * Un finto portale di fantacalcio: serve payload JSON annidati, con nomi di
 * campo in italiano e in un dialetto tutto suo, cioe' proprio la forma che il
 * profilo esiste per normalizzare.
 *
 * Non e' un mock dell'estensione: e' un sito vero, con richieste vere, che
 * l'estensione intercetta senza sapere che e' finto. E' l'unico modo di
 * dimostrare la catena — intercettazione, mappatura, relay — senza avere in
 * mano i payload della piattaforma reale.
 *
 * Una risposta parte da `fetch` e una da `XMLHttpRequest`, di proposito: sono
 * due strade diverse dentro la pagina e vanno coperte entrambe.
 */
import { createServer } from 'node:http';
import { DEFAULT_RULESET } from '@fantacomics/core';
import {
  generateWorld, withOfficialScores, nudgeTeamToScore, payloadPortaleDiProva,
} from '@fantacomics/ingest';

const PORTA = Number(process.env.PORTALE_PORT ?? 4173);
const GIORNATA = Number(process.env.PORTALE_GIORNATA ?? 7);

let mondo = generateWorld({ seed: 'portale-di-prova', teams: 8, matchday: GIORNATA });
mondo = nudgeTeamToScore(mondo, 't1', 71.5, DEFAULT_RULESET, { strict: false });
mondo = withOfficialScores(mondo, DEFAULT_RULESET);
const payloads = payloadPortaleDiProva(mondo.serieA, mondo.snapshot);

const PAGINA = `<!doctype html>
<meta charset="utf-8">
<title>FantaLega — Giornata ${GIORNATA}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; }
  code { background: #eee; padding: .1em .3em; }
  li { margin: .2em 0; }
</style>
<h1>FantaLega</h1>
<p>Giornata ${GIORNATA}. Questa pagina scarica i propri dati come farebbe un portale vero.</p>
<ul id="stato"></ul>

<script>
  const stato = document.getElementById('stato');
  function segna(nome, n) {
    const li = document.createElement('li');
    li.textContent = nome + ': ' + n + ' elementi';
    li.dataset.risorsa = nome;
    stato.append(li);
  }

  // Quattro risposte via fetch...
  for (const [nome, url, radice] of [
    ['voti', '/api/voti', 'giocatori'],
    ['formazioni', '/api/formazioni', 'schieramenti'],
    ['calendario', '/api/calendario', 'incontri'],
    ['rose', '/api/rose', 'rose'],
  ]) {
    fetch(url).then((r) => r.json()).then((j) => segna(nome, j.data[radice].length));
  }

  // ...e una via XMLHttpRequest, che dentro la pagina e' una strada diversa.
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/classifica');
  xhr.addEventListener('load', () => {
    segna('classifica', JSON.parse(xhr.responseText).data.classifica.length);
  });
  xhr.send();
</script>`;

const server = createServer((req, res) => {
  const percorso = (req.url ?? '/').split('?')[0] ?? '/';

  if (percorso === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGINA);
    return;
  }

  const id = percorso.replace(/^\/api\//, '');
  const payload = (payloads as Record<string, unknown>)[id];
  if (percorso.startsWith('/api/') && payload !== undefined) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('non trovato');
});

server.listen(PORTA, '127.0.0.1', () => {
  console.log(`portale di prova su http://127.0.0.1:${PORTA} (giornata ${GIORNATA})`);
});
