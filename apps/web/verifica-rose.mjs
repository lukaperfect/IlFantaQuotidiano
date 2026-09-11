/**
 * Verifica del percorso rose: un admin carica il foglio che la sua
 * piattaforma produce, e dall'altra parte esiste una lega.
 *
 * Sta in un file a parte dallo smoke perche' verifica una cosa diversa — non
 * i confini di sicurezza ma l'ingresso dei dati veri — e perche' ha bisogno
 * di un file da caricare, che si passa da fuori.
 *
 *   node apps/web/verifica-rose.mjs <percorso del .xlsx>
 *
 * Senza argomento usa un foglio generato con la stessa forma: cosi' la
 * verifica gira in CI, dove il file di una lega vera non c'e' e non deve
 * esserci.
 */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = 'http://localhost:3000';
const POSTA = process.env.FANTACOMICS_MAIL_LOG ?? '';

const problemi = [];
const esiti = [];
const ok = (nome, cond, extra = '') => {
  esiti.push(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
};

async function ultimoLinkDalLog() {
  let testo = '';
  try { testo = await readFile(POSTA, 'utf8'); } catch { return null; }
  const trovati = [...testo.matchAll(/http:\/\/localhost:3000\/accedi\/[A-Za-z0-9_-]+/g)];
  return trovati.length ? trovati[trovati.length - 1][0] : null;
}

/** Il foglio di ripiego: stessa forma del file della piattaforma. */
async function foglioGenerato(dir) {
  const { costruisciXlsx, foglioRose, rosaProva } = await import(
    '../../packages/ingest/src/__fixtures__/xlsx-builder.ts'
  );
  const squadre = ['Alfa FC', 'Beta United', 'Gamma Calcio', 'Delta Team'].map((nome, i) => ({
    nome, giocatori: rosaProva(`S${i}`),
  }));
  const percorso = join(dir, 'rose.xlsx');
  await writeFile(percorso, costruisciXlsx(foglioRose(squadre), 'ROSE'));
  return { percorso, squadre: squadre.length, giocatori: squadre.length * 25 };
}

const dir = await mkdtemp(join(tmpdir(), 'fc-rose-'));
const daRiga = process.argv[2];
const sorgente = daRiga
  ? { percorso: daRiga, squadre: null, giocatori: null }
  : await foglioGenerato(dir);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
page.on('response', (r) => { if (r.status() >= 500) problemi.push(`${r.status()} ${r.url()}`); });

// Accesso
const prima = await ultimoLinkDalLog();
await page.goto(`${base}/accedi`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'rose@example.com');
await page.click('button:has-text("Mandami il link")');
await page.locator('.notice').waitFor({ state: 'visible', timeout: 20000 });
let href = null;
for (let i = 0; i < 40 && !href; i++) {
  const corrente = await ultimoLinkDalLog();
  if (corrente && corrente !== prima) href = corrente;
  else await page.waitForTimeout(250);
}
if (!href) throw new Error('nessun magic link nel log del mailer');
await page.goto(href, { waitUntil: 'domcontentloaded' });
await page.waitForURL(`${base}/`, { timeout: 15000 }).catch(() => {});
ok('accesso', page.url() === `${base}/`, page.url());

// 1. Il modulo esiste e dice cosa vuole
await page.goto(`${base}/lega/nuova`, { waitUntil: 'domcontentloaded' });
const modulo = page.locator('form[data-modulo="rose-xlsx"]');
ok('il modulo delle rose e\' in pagina', await modulo.count() === 1);
ok('accetta .xlsx', (await modulo.locator('input[name="roseXlsx"]').getAttribute('accept')) === '.xlsx');

// 2. Un file che non e' un xlsx viene respinto con un messaggio, non con una
//    pagina di guasto. E' il caso piu' probabile in assoluto: si carica il
//    file sbagliato molto piu' spesso di quanto si carichi quello giusto.
const finto = join(dir, 'sbagliato.xlsx');
await writeFile(finto, 'questo e un csv travestito');
await modulo.locator('input[name="leagueName"]').fill('Lega Sbagliata');
await modulo.locator('input[name="roseXlsx"]').setInputFiles(finto);
await modulo.locator('button[type="submit"]').click();
const errore = modulo.locator('.notice.error');
await errore.waitFor({ state: 'visible', timeout: 30000 });
const testoErrore = (await errore.textContent())?.trim() ?? '';
ok('un file che non e\' un xlsx spiega il problema', /xlsx/i.test(testoErrore), testoErrore);
ok('e resta sul modulo invece di andare su una pagina d\'errore',
   page.url().includes('/lega/nuova'), page.url());

// 3. Il file vero
await modulo.locator('input[name="leagueName"]').fill('Lega delle Rose');
await modulo.locator('input[name="roseXlsx"]').setInputFiles(sorgente.percorso);
await modulo.locator('button[type="submit"]').click();
await page.waitForURL(/\/lega\/lega-/, { timeout: 60000 }).catch(() => {});
ok('il caricamento porta alla lega', /\/lega\/lega-/.test(page.url()), page.url());

// 4. Le rose sono davvero entrate: si guarda cosa ha lo store, non cosa
//    dice la pagina.
const idLega = page.url().split('/lega/')[1]?.split(/[?#]/)[0] ?? '';
const { store } = await import('../../apps/web/lib/store.ts');
const rosa = await store.getRoster(idLega);
ok('le rose sono persistite', rosa !== null);
if (rosa) {
  const giocatori = rosa.teams.reduce((a, t) => a + t.players.length, 0);
  ok('tutte le squadre del file sono entrate',
     sorgente.squadre === null || rosa.teams.length === sorgente.squadre,
     `${rosa.teams.length} squadre`);
  ok('tutti i giocatori sono entrati',
     sorgente.giocatori === null || giocatori === sorgente.giocatori,
     `${giocatori} giocatori`);
  ok('ogni rosa ha il layout 3-8-8-6', rosa.teams.every((t) => {
    const conta = (r) => t.players.filter((p) => p.role === r).length;
    return conta('P') === 3 && conta('D') === 8 && conta('C') === 8 && conta('A') === 6;
  }));
  ok('i prezzi d\'asta sono numeri, non stringhe',
     rosa.teams.every((t) => t.players.every((p) => typeof p.purchasePrice === 'number')));
  ok('nessun giocatore in due squadre',
     new Set(rosa.teams.flatMap((t) => t.players.map((p) => p.playerId))).size === giocatori);
  ok('la provenienza e\' registrata', rosa.source === 'xlsx-rose', rosa.source);
  const piuPagato = rosa.teams.flatMap((t) => t.players).sort((a, b) => b.purchasePrice - a.purchasePrice)[0];
  esiti.push(`INFO  ${rosa.teams.length} squadre, ${giocatori} giocatori, ` +
             `piu' pagato ${piuPagato.playerName} a ${piuPagato.purchasePrice}`);
}

// 5. Ricaricare lo stesso file non duplica: e' l'errore piu' naturale che
//    faccia un admin che non e' sicuro che il primo tentativo sia andato.
await page.goto(`${base}/lega/nuova`, { waitUntil: 'domcontentloaded' });
const modulo2 = page.locator('form[data-modulo="rose-xlsx"]');
await modulo2.locator('input[name="leagueName"]').fill('Lega delle Rose');
await modulo2.locator('input[name="roseXlsx"]').setInputFiles(sorgente.percorso);
await modulo2.locator('button[type="submit"]').click();
await page.waitForURL(/\/lega\/lega-/, { timeout: 60000 }).catch(() => {});
const rosaDopo = await store.getRoster(idLega);
ok('ricaricare lo stesso file sostituisce invece di accumulare',
   rosaDopo !== null && rosaDopo.teams.length === (rosa?.teams.length ?? -1),
   `${rosaDopo?.teams.length} squadre`);

console.log(esiti.join('\n'));
await browser.close();
if (problemi.length) {
  console.error(`\n${problemi.length} problemi:\n- ${problemi.join('\n- ')}`);
  process.exit(1);
}
console.log('\nPercorso rose: tutto verde.');
