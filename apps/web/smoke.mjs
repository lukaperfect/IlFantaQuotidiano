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

async function accedi(page, email) {
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

// 5. Un altro account non vede la lega di Mario
const giulia = await nuovaSessione();
await accedi(giulia.page, 'giulia@example.com');
const legheGiulia = await giulia.page.locator('.card-list li').count();
ok('Giulia non vede leghe di Mario', legheGiulia === 0, `${legheGiulia} leghe visibili`);
const resp = await giulia.page.goto(`${base}/lega/${legaId}`, { waitUntil: 'domcontentloaded' });
ok('lega altrui risponde 404', resp?.status() === 404, `status ${resp?.status()}`);

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
