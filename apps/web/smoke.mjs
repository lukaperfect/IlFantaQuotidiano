/**
 * Smoke test dell'app, con particolare attenzione alle proprieta' di sicurezza:
 * che un visitatore senza sessione non veda nulla di privato, che due account
 * siano isolati, e che rigenerare lo slug revochi davvero il link precedente.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const POSTA = process.env.FANTACOMICS_MAIL_LOG ?? '';

/**
 * Il link si legge dalla posta consegnata, non dall'interfaccia.
 * In produzione l'app NON lo mostra mai in pagina — e' proprio il controllo
 * che vogliamo attivo — quindi prenderlo dal log e' l'unico modo di testare
 * il percorso reale invece di una scorciatoia di sviluppo.
 */
async function ultimoLinkDalLog() {
  let testo = '';
  try { testo = await readFile(POSTA, 'utf8'); } catch { return null; }
  const trovati = [...testo.matchAll(/http:\/\/localhost:3000\/accedi\/[A-Za-z0-9_-]+/g)];
  return trovati.length ? trovati[trovati.length - 1][0] : null;
}

const base = 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problemi = [];
const esiti = [];
const ok = (nome, cond, extra = '') => {
  esiti.push(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
};

async function nuovaSessione() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) problemi.push(`${r.status()} ${r.url()}`); });
  return { ctx, page };
}

/** Chiede il link e lo legge dalla posta, SENZA aprirlo. */
async function chiediLink(page, email) {
  const prima = await ultimoLinkDalLog();
  await page.goto(`${base}/accedi`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Mandami il link")');
  await page.locator('.notice').waitFor({ state: 'visible', timeout: 20000 });

  ok(`nessun link in chiaro in pagina (${email})`,
     (await page.locator('.notice a').count()) === 0);

  let href = null;
  for (let i = 0; i < 40 && !href; i++) {
    const corrente = await ultimoLinkDalLog();
    if (corrente && corrente !== prima) href = corrente;
    else await page.waitForTimeout(250);
  }
  if (!href) throw new Error('nessun magic link trovato nel log del mailer');
  return href;
}

async function accedi(page, email) {
  const href = await chiediLink(page, email);
  // Stesso browser che ha chiesto il link: deve entrare senza attrito.
  await page.goto(href, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`${base}/`, { timeout: 15000 }).catch(() => {});
  return href;
}

// 1. Senza sessione la home porta al login
const anon = await nuovaSessione();
await anon.page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await anon.page.waitForURL('**/accedi', { timeout: 15000 }).catch(() => {});
ok('home protetta senza sessione', anon.page.url().includes('/accedi'), anon.page.url());
await anon.page.goto(`${base}/lega/lega-qualunque`, { waitUntil: 'domcontentloaded' });
await anon.page.waitForURL('**/accedi', { timeout: 15000 }).catch(() => {});
ok('pagina lega protetta senza sessione', anon.page.url().includes('/accedi'));

// 2. Accesso di Mario e creazione lega
const mario = await nuovaSessione();
const linkUsato = await accedi(mario.page, 'mario@example.com');
ok('accesso via magic link', mario.page.url() === `${base}/`, mario.page.url());

// 3. Il magic link e' monouso
const riuso = await nuovaSessione();
await riuso.page.goto(linkUsato, { waitUntil: 'domcontentloaded' });
ok('magic link monouso', riuso.page.url().includes('errore=usato'), riuso.page.url());
await riuso.ctx.close();

/**
 * 3-bis. Un link APERTO DA UN ALTRO BROWSER non apre una sessione da solo.
 *
 * E' il caso che conta: chi chiede un link per se' e lo gira a qualcun altro
 * autenticherebbe il browser di quella persona nel PROPRIO account — e da
 * quel momento tutto cio' che carica finisce in un archivio non suo, senza
 * nessuno dei segnali che rendono riconoscibile una truffa, perche' dominio,
 * certificato e interfaccia sono quelli veri.
 */
const chiedente = await nuovaSessione();
const linkGirato = await chiediLink(chiedente.page, 'chiara@example.com');

const altroDispositivo = await nuovaSessione();
await altroDispositivo.page.goto(linkGirato, { waitUntil: 'domcontentloaded' });
ok('link aperto altrove non entra ma chiede conferma',
   altroDispositivo.page.url().endsWith('/conferma'), altroDispositivo.page.url());
ok('la conferma dice in quale account si sta entrando',
   (await altroDispositivo.page.locator('.account-conferma').innerText()).trim()
     === 'chiara@example.com');

// E finche' non si conferma, nessuna sessione: la home resta chiusa.
await altroDispositivo.page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await altroDispositivo.page.waitForURL('**/accedi', { timeout: 15000 }).catch(() => {});
ok('nessuna sessione prima della conferma',
   altroDispositivo.page.url().includes('/accedi'), altroDispositivo.page.url());

// Confermando si entra: aprire da un altro dispositivo resta legittimo.
await altroDispositivo.page.goto(linkGirato, { waitUntil: 'domcontentloaded' });
await altroDispositivo.page.click('button:has-text("Sono io, entra")');
await altroDispositivo.page.waitForURL(`${base}/`, { timeout: 15000 }).catch(() => {});
ok('la conferma esplicita apre la sessione',
   altroDispositivo.page.url() === `${base}/`, altroDispositivo.page.url());
await altroDispositivo.ctx.close();
await chiedente.ctx.close();

await mario.page.click('text=Collega una lega');
await mario.page.waitForURL('**/lega/nuova');
const formProva = mario.page.locator('form').filter({ hasText: 'Genera la lega di prova' });
await formProva.locator('input[name="leagueName"]').fill('Lega di Mario');
await formProva.locator('button:has-text("Genera la lega di prova")').click();
await mario.page.waitForSelector('h2:has-text("Edizioni")', { timeout: 90000 });
const legaUrl = mario.page.url();
const legaId = legaUrl.split('/lega/')[1];
const linkPubblico = (await mario.page.locator('.share-box code').textContent())?.trim() ?? '';
ok('link pubblico mostrato', linkPubblico.includes('/g/'), linkPubblico);

// 4. Il giornale si legge SENZA sessione
const lettore = await nuovaSessione();
await lettore.page.goto(linkPubblico, { waitUntil: 'domcontentloaded' });
await lettore.page.locator('article.art').first().waitFor({ state: 'visible', timeout: 20000 });
const pezzi = await lettore.page.locator('article.art').count();
ok('giornale leggibile senza account', pezzi > 0, `${pezzi} pezzi`);

/**
 * E il giornale non deve finire nei motori di ricerca.
 *
 * L'indirizzo e' un segreto revocabile: quella promessa l'ho gia' dovuta
 * difendere dalle cache HTTP, e i motori sono la stessa minaccia con una
 * memoria molto piu' lunga. Basta che qualcuno incolli il link in un forum
 * perche' nomi, punteggi e sfottio' diventino cercabili per sempre — e
 * rigenerare lo slug a quel punto non revoca piu' niente.
 */
const slugPubblico = linkPubblico.split('/g/')[1].split('/')[0];
for (const [nome, percorso] of [
  ['giornale', `/g/${slugPubblico}/3`],
  ['versione da stampa', `/g/${slugPubblico}/3/stampa`],
]) {
  const r = await lettore.page.request.get(`${base}${percorso}`);
  ok(`${nome}: header noindex`,
     (r.headers()['x-robots-tag'] ?? '').includes('noindex'),
     r.headers()['x-robots-tag'] ?? '(assente)');
}
ok('il documento del giornale porta anche il meta robots',
   (await (await lettore.page.request.get(`${base}/g/${slugPubblico}/3`)).text())
     .includes('name="robots" content="noindex'));

const robots = await lettore.page.request.get(`${base}/robots.txt`);
const testoRobots = await robots.text();
ok('robots.txt esiste', robots.status() === 200, `status ${robots.status()}`);
// Il punto sottile: `/g/` NON va vietato, altrimenti il motore non scarica la
// pagina e non legge mai il noindex che gli stiamo chiedendo di rispettare.
ok('robots.txt non vieta /g/, cosi’ il noindex viene letto',
   !/Disallow:\s*\/g\//.test(testoRobots), testoRobots.replace(/\n/g, ' | ').slice(0, 90));
ok('robots.txt vieta l’API', /Disallow:[^\n]*\/api\//.test(testoRobots));

// 5. Un altro account non vede la lega di Mario
const giulia = await nuovaSessione();
await accedi(giulia.page, 'giulia@example.com');
const legheGiulia = await giulia.page.locator('.card-list li').count();
ok('Giulia non vede leghe di Mario', legheGiulia === 0, `${legheGiulia} leghe visibili`);
const resp = await giulia.page.goto(`${base}/lega/${legaId}`, { waitUntil: 'domcontentloaded' });
ok('lega altrui risponde 404', resp?.status() === 404, `status ${resp?.status()}`);

/**
 * 5-bis. L'anteprima di revisione e' del proprietario, non di chi ha il link.
 *
 * Un'edizione sotto soglia non si serve al pubblico, ma l'admin deve poterla
 * rivedere: quella pagina passa dall'id interno e dalla sessione, non dallo
 * slug condiviso. Qui si verifica proprio quel confine — la porta sulla
 * soglia e' verificata dove si puo' fabbricare un'edizione scadente, cioe'
 * nella verifica del relay, che parla direttamente con lo store.
 */
const anteprimaProprietario = await mario.page.request.get(`${base}/lega/${legaId}/anteprima/1`);
ok('il proprietario puo’ rivedere una sua edizione',
   anteprimaProprietario.status() === 200, `status ${anteprimaProprietario.status()}`);

const anteprimaEstraneo = await lettore.page.request.get(`${base}/lega/${legaId}/anteprima/1`);
ok('chi ha solo il link pubblico non puo’ aprire l’anteprima',
   anteprimaEstraneo.status() === 404, `status ${anteprimaEstraneo.status()}`);

/**
 * 5-quater. L'interruttore di emergenza si aziona davvero.
 *
 * Il percorso da file e' cio' che tiene in piedi il prodotto se la piattaforma
 * chiude gli accessi. Ma il modulo chiedeva cinque CSV senza dire quali
 * colonne servissero: l'unico modo di scoprirlo era leggere il codice, e un
 * interruttore che non sai azionare non e' un interruttore.
 *
 * Qui si scaricano i modelli e si rimettono dentro dal modulo vero. Se
 * l'esportatore e l'importatore divergessero, questo passo lo direbbe subito.
 */
const modelli = {};
for (const nome of ['voti', 'formazioni', 'calendario', 'rose', 'classifica']) {
  const r = await mario.page.request.get(`${base}/modelli/${nome}.csv`);
  ok(`modello ${nome}.csv scaricabile`, r.status() === 200, `status ${r.status()}`);
  modelli[nome] = await r.text();
}

await mario.page.goto(`${base}/lega/nuova`, { waitUntil: 'domcontentloaded' });
// Le colonne sono anche a schermo: non si deve indovinare niente.
const colonne = await mario.page.locator('.colonne').first().innerText();
ok('le colonne attese sono scritte in pagina', colonne.includes('playerId'), colonne.slice(0, 60));

const formFile = mario.page.locator('form').filter({ hasText: 'Importa e genera' });
await formFile.locator('input[name="leagueName"]').fill('Lega da File');
for (const [nome, testo] of Object.entries(modelli)) {
  await formFile.locator(`input[name="${nome}"]`).setInputFiles({
    name: `${nome}.csv`, mimeType: 'text/csv', buffer: Buffer.from(testo, 'utf8'),
  });
}
await formFile.locator('button:has-text("Importa e genera")').click();
await mario.page.waitForSelector('h2:has-text("Edizioni")', { timeout: 120000 });
const pezziDaFile = await mario.page.locator('.card-list li').count();
ok('una lega nata dai soli modelli produce un giornale', pezziDaFile >= 1,
   `${pezziDaFile} edizioni`);

/**
 * E un file sbagliato deve DIRE cosa non andava.
 *
 * E' il modo piu' probabile di fallire su questo percorso: una colonna con un
 * altro nome, una riga senza playerId, dieci titolari invece di undici.
 * L'importatore lo sa dire con precisione, e quei messaggi finivano inghiottiti
 * da una pagina d'errore generica — lasciando come unica strategia rinunciare.
 */
const righeVoti = modelli.voti.split('\n');
const guasto = [righeVoti[0], righeVoti[1].replace(/^[^,]*/, ''), ...righeVoti.slice(2)].join('\n');

await mario.page.goto(`${base}/lega/nuova`, { waitUntil: 'domcontentloaded' });
const formGuasto = mario.page.locator('form').filter({ hasText: 'Importa e genera' });
await formGuasto.locator('input[name="leagueName"]').fill('Lega Rotta');
for (const [nome, testo] of Object.entries({ ...modelli, voti: guasto })) {
  await formGuasto.locator(`input[name="${nome}"]`).setInputFiles({
    name: `${nome}.csv`, mimeType: 'text/csv', buffer: Buffer.from(testo, 'utf8'),
  });
}
await formGuasto.locator('button:has-text("Importa e genera")').click();
await mario.page.locator('.notice.error').waitFor({ state: 'visible', timeout: 60000 });
const messaggio = await mario.page.locator('.notice.error').innerText();
ok('un CSV sbagliato spiega cosa non andava invece di esplodere',
   /playerId/i.test(messaggio), messaggio.slice(0, 90));
ok('e si resta sul modulo, non su una pagina d’errore',
   mario.page.url().includes('/lega/nuova'), mario.page.url());

await mario.page.goto(legaUrl, { waitUntil: 'domcontentloaded' });
await mario.page.locator('.share-box code').waitFor({ state: 'visible', timeout: 20000 });

// 6. Rigenerare lo slug revoca il link precedente
await mario.page.goto(legaUrl, { waitUntil: 'domcontentloaded' });
await mario.page.locator('.share-box code').waitFor({ state: 'visible', timeout: 20000 });
await mario.page.click('button:has-text("Rigenera il link")');
// Si attende che il valore CAMBI: la presenza dell'elemento non prova che la
// pagina sia gia' quella nuova, e leggerlo subito restituisce il vecchio.
await mario.page.locator('.share-box code')
  .filter({ hasNotText: linkPubblico })
  .waitFor({ state: 'visible', timeout: 20000 });
const nuovoLink = (await mario.page.locator('.share-box code').textContent())?.trim() ?? '';
ok('slug rigenerato', nuovoLink !== linkPubblico);
const vecchio = await lettore.page.goto(linkPubblico, { waitUntil: 'domcontentloaded' });
ok('link vecchio revocato', vecchio?.status() === 404, `status ${vecchio?.status()}`);
const nuovo = await lettore.page.goto(nuovoLink, { waitUntil: 'domcontentloaded' });
ok('link nuovo valido', nuovo?.status() === 200, `status ${nuovo?.status()}`);

// 7. Uscita
await mario.page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await mario.page.click('button:has-text("Esci")');
await mario.page.waitForLoadState('networkidle');
ok('uscita riporta al login', mario.page.url().includes('/accedi'), mario.page.url());
await mario.page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await mario.page.waitForURL('**/accedi', { timeout: 15000 }).catch(() => {});
ok('dopo l’uscita la home è protetta', mario.page.url().includes('/accedi'));

console.log(esiti.join('\n'));
console.log(problemi.length === 0 ? '\nTUTTO OK' : `\nPROBLEMI: ${problemi.join(' | ')}`);
await browser.close();
process.exit(problemi.length === 0 ? 0 : 1);
