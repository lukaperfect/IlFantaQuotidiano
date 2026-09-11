/**
 * VERIFICA DEL RACCOGLITORE DA BROWSER.
 *
 * `strumenti/raccogli-fonte.js` gira in un posto che nessun test unitario
 * raggiunge: la console di un browser, su una pagina di qualcun altro. Senza
 * questa verifica sarebbe l'unico pezzo del progetto la cui correttezza si
 * basa sull'averlo letto — e verrebbe scoperto rotto dall'utente, che e'
 * proprio la persona che non ha modo di aggiustarlo.
 *
 * Qui si alza un sito finto che si comporta come quelli veri (i dati NON
 * stanno nell'HTML, arrivano dopo con una richiesta), si guida un Chromium
 * vero, si incolla lo script come lo incollerebbe una persona, e si controlla
 * che il file che ne esce, dato in pasto all'ispettore, dica i nomi dei campi.
 *
 *   pnpm exec tsx apps/worker/src/scripts/verifica-raccolta.ts
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const esegui = promisify(execFile);

const PAGINA = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Voti — sito finto</title>
<style>body{font-family:sans-serif}</style>
<script type="application/json" id="__NEXT_DATA__">
{"props":{"pageProps":{"stagione":"2026-27","csrfToken":"NEMMENOQUESTO",
"menu":[{"voce":"Serie A","author":"Mario Rossi"},{"voce":"Serie B","author":"Anna Bianchi"}]}}}
</script>
</head><body>
<h1>Voti</h1>
<!-- un commento che non deve finire nel raccolto -->
<button id="carica">Giornata 5</button>
<button id="calendario">Calendario</button>
<ul id="esito"></ul>
<ul id="partite"></ul>
<script>
/*
 * Il secondo bottone usa XMLHttpRequest con responseType 'json': e' il caso in
 * cui leggere responseText LANCIA. Un registratore scritto senza guardia
 * romperebbe ogni richiesta della pagina, e i siti italiani di sport sono
 * pieni di jQuery, quindi di XHR.
 */
document.getElementById('calendario').addEventListener('click', () => {
  const x = new XMLHttpRequest();
  x.open('GET', '/api/calendario');
  x.responseType = 'json';
  x.onload = () => {
    document.getElementById('partite').innerHTML =
      x.response.matches.map((p) => '<li>' + p.homeTeam + '</li>').join('');
  };
  x.send();
});
document.getElementById('carica').addEventListener('click', async () => {
  const r = await fetch('/api/voti?giornata=5&auth_token=SEGRETISSIMO');
  const dati = await r.json();
  document.getElementById('esito').innerHTML =
    dati.data.players.map((g) => '<li>' + g.name + '</li>').join('');
});
</script>
</body></html>`;

const CALENDARIO = {
  matches: [
    { id: 71, matchday: 5, homeTeam: 'Inter', awayTeam: 'Milan', status: 'FINISHED', utcDate: '2026-09-12T18:45:00Z' },
    { id: 72, matchday: 5, homeTeam: 'Roma', awayTeam: 'Lazio', status: 'FINISHED', utcDate: '2026-09-13T18:45:00Z' },
  ],
};

const VOTI = {
  data: {
    matchday: 5,
    players: [
      { id: 2341, name: 'Martinez L.', role: 'A', team: 'Inter', grade: 7.5, fantaGrade: 13.5, minutesPlayed: 90, goals: 2, assists: 0, yellowCards: 0 },
      { id: 1188, name: 'Sommer', role: 'P', team: 'Inter', grade: 6, fantaGrade: 5, minutesPlayed: 90, goals: 0, assists: 0, yellowCards: 0 },
      { id: 990, name: 'Bastoni', role: 'D', team: 'Inter', grade: 6.5, fantaGrade: 6.5, minutesPlayed: 74, goals: 0, assists: 1, yellowCards: 1 },
    ],
  },
};

function esigi(condizione: boolean, cosa: string): void {
  console.log(`${condizione ? '  ok  ' : ' ROTTO'} ${cosa}`);
  if (!condizione) process.exitCode = 1;
}

async function main(): Promise<void> {
  const sito = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/calendario')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CALENDARIO));
      return;
    }
    if ((req.url ?? '').startsWith('/api/voti')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(VOTI));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGINA);
  });
  await new Promise<void>((ok) => sito.listen(0, '127.0.0.1', ok));
  const porta = (sito.address() as { port: number }).port;
  const indirizzo = `http://127.0.0.1:${porta}/`;
  console.log(`Sito finto su ${indirizzo}\n`);

  const cartella = await mkdtemp(join(tmpdir(), 'fc-raccolta-'));
  const script = await readFile('strumenti/raccogli-fonte.js', 'utf8');

  // Come nelle altre verifiche: il build completo, non la headless shell.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' },
  );
  const contesto = await browser.newContext({ acceptDownloads: true });
  const pagina = await contesto.newPage();
  await pagina.goto(indirizzo, { waitUntil: 'networkidle' });

  // Lo script arriva DOPO il caricamento, come quando lo si incolla a mano.
  const primo = pagina.waitForEvent('download');
  await pagina.evaluate(script);
  await (await primo).path();

  /**
   * Il caso che conta: la richiesta parte DOPO l'incollaggio. Quelle partite
   * prima non si possono piu' leggere, ed e' la ragione per cui lo script dice
   * di cambiare giornata e riesportare invece di restituire un file vuoto
   * lasciando credere che non ci sia niente da trovare.
   */
  await pagina.click('#carica');
  /**
   * L'attesa e' corta e l'errore viene inghiottito di proposito: se il
   * registratore ha rotto la pagina, questa verifica lo deve DIRE, non morire
   * dopo trenta secondi con un timeout che non nomina il colpevole. E' il caso
   * in cui si legge il corpo della risposta senza clonarlo: la pagina riceve
   * un flusso gia' consumato e smette di funzionare.
   */
  let resi: (string | null)[] = [];
  try {
    await pagina.waitForSelector('#esito li', { timeout: 5000 });
    resi = await pagina.$$eval('#esito li', (n) => n.map((x) => x.textContent));
  } catch { /* resi resta vuoto, e l'asserzione qui sotto lo dice */ }
  esigi(resi.length === 3, 'la pagina continua a funzionare col registratore attivo');

  await pagina.click('#calendario');
  let partite: (string | null)[] = [];
  try {
    await pagina.waitForSelector('#partite li', { timeout: 5000 });
    partite = await pagina.$$eval('#partite li', (n) => n.map((x) => x.textContent));
  } catch { /* idem */ }
  esigi(partite.length === 2, 'e continua a funzionare anche con XMLHttpRequest');

  const secondo = pagina.waitForEvent('download');
  await pagina.evaluate('fantacomicsEsporta()');
  const scaricato = await secondo;
  const file = join(cartella, 'fantacomics-raccolta.json');
  await writeFile(file, await readFile(await scaricato.path(), 'utf8'));
  await browser.close();
  sito.close();

  const raccolta = JSON.parse(await readFile(file, 'utf8')) as {
    fantacomics: string; pagina: string;
    rete: { url: string; corpo: string | null }[];
  };

  console.log('\n── Il file raccolto');
  esigi(raccolta.fantacomics === 'raccolta-1', 'e\' marcato come raccolta');
  const voti = raccolta.rete.find((r) => r.url.includes('/api/voti'));
  esigi(voti !== undefined, 'la richiesta dei voti e\' nell\'elenco');
  esigi(voti?.corpo != null && voti.corpo.includes('Martinez'), 'col contenuto della risposta');
  esigi(voti?.url.includes('auth_token=RIMOSSO') === true, 'il parametro segreto e\' stato tolto');
  /**
   * Il segreto NON stava solo nell'indirizzo: stava anche nello script della
   * pagina, che il raccoglitore conserva apposta perche' e' li' che vivono i
   * dati. La prima versione di questo script lo spediva, e l'ha detto questa
   * verifica, non una rilettura del codice.
   */
  esigi(!JSON.stringify(raccolta).includes('SEGRETISSIMO'), 'e non e\' rimasto da nessun\'altra parte');
  esigi(!raccolta.pagina.includes('NEMMENOQUESTO'), 'anche il token dentro il JSON della pagina sparisce');
  esigi(raccolta.pagina.includes('csrfToken'), 'ma il NOME del campo resta, cosi\' si sa che c\'era');
  esigi(raccolta.pagina.includes('Mario Rossi'), 'e "author" non viene scambiato per una credenziale');
  esigi(raccolta.pagina.includes('__NEXT_DATA__'), 'il documento conserva i blocchi JSON');
  esigi(!raccolta.pagina.includes('<style'), 'e non si porta dietro i fogli di stile');
  esigi(!raccolta.pagina.includes('non deve finire'), 'ne\' i commenti');
  esigi(raccolta.pagina.includes('Martinez'), 'ed e\' il DOM di adesso, non l\'HTML di partenza');
  const cal = raccolta.rete.find((r) => r.url.includes('/api/calendario'));
  esigi(cal?.corpo != null && cal.corpo.includes('Milan'), 'anche la risposta XHR viene catturata');

  console.log('\n── L\'ispettore su quel file');
  const { stdout } = await esegui('pnpm', [
    'exec', 'tsx', 'apps/worker/src/scripts/ispeziona-fonte.ts', '--file', file,
  ], { maxBuffer: 8 * 1024 * 1024 });
  console.log(stdout.split('\n').map((r) => `   ${r}`).join('\n'));

  esigi(stdout.includes('Raccolta da browser'), 'riconosce il formato senza che glielo si dica');
  esigi(stdout.includes('RISPOSTA DI') && stdout.includes('/api/voti'), 'ispeziona la risposta giusta');
  esigi(stdout.includes('data.players  →  3 elementi'), 'trova la radice dell\'elenco');
  esigi(/playerName\s+← name/.test(stdout), 'e propone la mappatura dei campi');
  esigi(stdout.includes('"root": "data.players"'), 'la bozza di profilo e\' pronta da incollare');
  esigi(stdout.includes('__NEXT_DATA__'), 'e il documento viene comunque elencato');
  esigi(/homeTeam\s+← homeTeam/.test(stdout), 'e riconosce i campi anche della seconda risposta');

  console.log(process.exitCode ? '\nQualcosa non va.' : '\nTutto a posto.');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
