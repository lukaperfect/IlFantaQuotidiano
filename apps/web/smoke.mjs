/**
 * Smoke test manuale dell'app.
 *
 * Percorre il flusso reale dell'admin: home -> onboarding -> lega di prova ->
 * lettura del giornale -> card condivisibile -> salvataggio del regolamento.
 * Verifica anche le cose che un test unitario non vede: che l'immagine della
 * card si carichi davvero, che l'URL dell'OG sia assoluto, e che nessuna
 * richiesta risponda 4xx.
 *
 * Uso:  pnpm start &  then  CHROMIUM_PATH=... node smoke.mjs
 */
import { chromium } from 'playwright';
const base = 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const problemi = [];
page.on('pageerror', (e) => problemi.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) problemi.push(`${r.status()} ${r.url()}`); });

await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'shots/1-home.png', fullPage: true });

await page.click('text=Collega una lega');
await page.waitForURL('**/lega/nuova');
await page.screenshot({ path: 'shots/2-onboarding.png', fullPage: true });

const formProva = page.locator('form').filter({ hasText: 'Genera la lega di prova' });
await formProva.locator('input[name="leagueName"]').fill('Lega dei Miracoli Mancati');
await formProva.locator('button:has-text("Genera la lega di prova")').click();
// Si attende un elemento della pagina lega, non l'URL: il glob '**/lega/**'
// matcherebbe subito /lega/nuova e non aspetterebbe nulla.
await page.waitForSelector('h2:has-text("Edizioni")', { timeout: 90000 });
await page.waitForLoadState('networkidle');
await page.screenshot({ path: 'shots/3-lega.png', fullPage: true });
const legaUrl = page.url();
console.log('LEGA:', legaUrl);
console.log('EDIZIONI ELENCATE:', await page.locator('.card-list li').count());

await page.click('a:has-text("Leggi")');
await page.waitForLoadState('networkidle');
await page.screenshot({ path: 'shots/4-giornale.png', fullPage: true });
console.log('PEZZI:', await page.locator('article.art').count());
console.log('CARD NEL GIORNALE:', await page.locator('.card').count());

await page.goto(legaUrl, { waitUntil: 'networkidle' });
await page.click('a:has-text("Card")');
await page.waitForLoadState('networkidle');
await page.screenshot({ path: 'shots/5-card.png', fullPage: true });
console.log('IMG CARD OK:', await page.locator('img').first().evaluate((el) => el.naturalWidth > 0));
const og = await page.locator('meta[property="og:image"]').getAttribute('content');
console.log('OG IMAGE:', og);

await page.goto(legaUrl, { waitUntil: 'networkidle' });
await page.fill('input[name="sogliaBase"]', '60');
await page.click('button:has-text("Salva")');
// Con useActionState non c'e' navigazione: `networkidle` scatta prima che
// l'azione risponda. Si aspetta la conferma, che e' il segnale vero.
await page.locator('.notice').waitFor({ state: 'visible', timeout: 20000 });
console.log('CONFERMA:', (await page.locator('.notice').textContent())?.trim());
await page.screenshot({ path: 'shots/6-config.png', fullPage: true });

// La persistenza si prova ricaricando: il valore nel campo e' solo cio' che
// ho digitato io, non la prova che sia stato salvato.
await page.reload({ waitUntil: 'networkidle' });
console.log('SOGLIA DOPO RICARICA:', await page.inputValue('input[name="sogliaBase"]'));

console.log('PROBLEMI:', problemi.length === 0 ? 'nessuno' : problemi);
await browser.close();
