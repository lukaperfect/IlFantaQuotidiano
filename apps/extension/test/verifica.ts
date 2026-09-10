/**
 * VERIFICA DELL'ESTENSIONE, IN UN BROWSER VERO.
 *
 * Non simula niente: carica l'estensione in Chromium, apre un portale finto
 * che scarica i propri dati come farebbe un sito vero, e controlla che la
 * catena regga tutta — intercettazione nella pagina, ponte verso il service
 * worker, invio al relay, giornale pubblicato.
 *
 * Le due asserzioni che contano piu' delle altre non riguardano il caso
 * felice: che a estensione DISARMATA non venga catturato niente, e che
 * "Ferma" butti davvero cio' che era in memoria. Un'estensione che legge
 * pagine altrui si giudica da cosa fa quando nessuno gliel'ha chiesto.
 */
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { DEFAULT_RULESET, stableHash } from '@fantacomics/core';
import { PostgresLeagueStore, FileLeagueStore, type LeagueStore } from '@fantacomics/pipeline';
import { randomToken } from '@fantacomics/auth';

/**
 * Il minimo dell'API delle estensioni, dichiarato qui.
 *
 * Questi riferimenti vivono dentro `evaluate`, cioe' eseguono nel browser e
 * non in questo processo: al compilatore serve solo sapere che il nome esiste.
 * Tirarsi dentro l'intero `@types/chrome` per due chiamate sarebbe peso senza
 * ritorno.
 */
declare const chrome: {
  runtime: { sendMessage(msg: unknown, cb: (r: unknown) => void): void };
  tabs: { query(q: { url?: string }): Promise<{ id?: number }[]> };
};

const ESTENSIONE = resolve(import.meta.dirname, '..');
const PORTALE = process.env.PORTALE_URL ?? 'http://127.0.0.1:4173';
const SERVER = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
const GIORNATA = Number(process.env.PORTALE_GIORNATA ?? 7);

const problemi: string[] = [];
function ok(nome: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
}

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const store: LeagueStore = pool
  ? new PostgresLeagueStore(pool)
  : new FileLeagueStore(process.env.FANTACOMICS_DATA ?? '.data');

/**
 * Il service worker MV3 puo' non essersi ancora avviato quando il contesto e'
 * pronto, quindi si aspetta. Ma se non arriva mai, la causa quasi certa e' una
 * sola e vale la pena dirla invece di lasciare un timeout muto: vedi il
 * commento su `chromiumCompleto` qui sotto.
 */
async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  const esistente = ctx.serviceWorkers()[0];
  if (esistente) return esistente;
  try {
    return await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  } catch {
    throw new Error(
      'Il service worker dell’estensione non si e’ mai avviato. Quasi sempre ' +
      'significa che Chromium e’ stato lanciato nella variante "headless shell", ' +
      'che le estensioni non le carica proprio. Serve il build completo: ' +
      'CHROMIUM_PATH verso il binario, oppure il canale "chromium".',
    );
  }
}

/**
 * QUALE CHROMIUM.
 *
 * Non e' un dettaglio di configurazione: `chromium` senza altro, in headless,
 * si risolve nella *headless shell*, un build ridotto che NON carica
 * estensioni. Il service worker non parte mai e il test muore su un timeout
 * che non dice niente — che e' esattamente come questa verifica ha fallito la
 * prima volta in CI, mentre in locale passava perche' li' il percorso del
 * build completo era esplicito.
 *
 * `channel: 'chromium'` chiede il build completo, che in headless moderno le
 * estensioni le carica.
 */
function chromiumCompleto(): { executablePath: string } | { channel: string } {
  return process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: 'chromium' };
}

async function main(): Promise<void> {
  const leagueId = `est-${stableHash(String(Date.now()))}`;
  const publicSlug = randomToken(18);
  const chiave = randomToken(24);
  await store.saveConfig({
    leagueId, ownerId: 'acc-verifica-estensione', publicSlug, relaySecret: chiave,
    leagueName: 'Lega dell’Estensione', ruleset: DEFAULT_RULESET, spice: 2,
    createdAt: new Date().toISOString(), lastMatchday: null,
  });

  const profilo = await mkdtemp(join(tmpdir(), 'fc-ext-'));
  const ctx = await chromium.launchPersistentContext(profilo, {
    headless: true,
    ...chromiumCompleto(),
    args: [
      `--disable-extensions-except=${ESTENSIONE}`,
      `--load-extension=${ESTENSIONE}`,
    ],
  });

  try {
    const sw = await serviceWorker(ctx);
    const idEstensione = new URL(sw.url()).host;
    ok('l’estensione si carica', idEstensione.length > 10, idEstensione);

    // Il popup e' anche il posto da cui si parla con il service worker.
    // La larghezza vera di un popup: una schermata a 1280 non direbbe se
    // l'interfaccia sta dove deve stare.
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 320, height: 620 });
    await popup.goto(`chrome-extension://${idEstensione}/src/popup.html`);
    await popup.fill('#server', SERVER);
    await popup.fill('#chiave', chiave);
    await popup.click('#salva');
    await popup.locator('#esito').waitFor({ state: 'visible' });

    const invia = (payload: unknown) =>
      popup.evaluate((p) => new Promise((r) => chrome.runtime.sendMessage(p, r)), payload);

    // --- 1. Disarmati non si cattura niente -------------------------------
    const pagina = await ctx.newPage();
    await pagina.goto(PORTALE, { waitUntil: 'load' });
    await pagina.locator('#stato li').nth(4).waitFor({ timeout: 20_000 });

    const idScheda = await popup.evaluate(async (u) => {
      const [t] = await chrome.tabs.query({ url: `${u}/*` });
      return t?.id ?? -1;
    }, PORTALE);
    ok('la scheda del portale e’ identificata', idScheda > 0, String(idScheda));

    const primaDiArmare = await invia({ tipo: 'stato', tabId: idScheda }) as { catturati: string[] };
    ok('a estensione disarmata non viene catturato NIENTE',
       primaDiArmare.catturati.length === 0, `${primaDiArmare.catturati.length} payload`);

    // --- 2. Si arma: la pagina si ricarica e le regole precedono le richieste
    const armato = await invia({ tipo: 'arma', tabId: idScheda, matchday: GIORNATA }) as
      { ok: boolean; lega?: string; regole?: number; errore?: string };
    ok('il profilo arriva dal server e arma la cattura',
       armato.ok === true && armato.regole === 5, armato.errore ?? `${armato.regole} regole, lega ${armato.lega}`);

    await pagina.waitForLoadState('load');
    await pagina.locator('#stato li').nth(4).waitFor({ timeout: 20_000 });
    // Il service worker riceve i payload subito dopo la pagina: piccola attesa
    // sul messaggio, non sul caso.
    for (let i = 0; i < 40; i++) {
      const s = await invia({ tipo: 'stato', tabId: idScheda }) as { catturati: string[] };
      if (s.catturati.length >= 5) break;
      await popup.waitForTimeout(250);
    }

    const dopo = await invia({ tipo: 'stato', tabId: idScheda }) as
      { catturati: string[]; obbligatori: string[]; lega: string | null };
    ok('intercettate tutte e cinque le risposte', dopo.catturati.length === 5, dopo.catturati.join(', '));
    ok('anche quella via XMLHttpRequest', dopo.catturati.includes('classifica'));
    ok('gli obbligatori ci sono tutti',
       ['voti', 'formazioni', 'calendario'].every((id) => dopo.catturati.includes(id)));
    ok('il popup sa di quale lega si tratta', dopo.lega === 'Lega dell’Estensione', String(dopo.lega));

    // Il popup mostra la spunta: e' l'unica cosa che l'utente vede davvero.
    await popup.reload();
    await popup.locator('#elenco li').first().waitFor();
    const righe = await popup.locator('#elenco li').allInnerTexts();
    ok('il popup mostra la lista di cio’ che ha preso',
       righe.filter((r) => r.includes('✓')).length === 5, righe.join(' | '));
    ok('il bottone di invio si sblocca solo da completi',
       (await popup.locator('#invia').isDisabled()) === false);

    // Un test verde non dice se il popup si guarda. Le schermate si sono gia'
    // mangiate cinque difetti che nessuna asserzione aveva visto.
    if (process.env.FC_SCHERMATA) {
      await popup.screenshot({ path: process.env.FC_SCHERMATA, fullPage: true });
    }

    // --- 3. Invio al relay -------------------------------------------------
    const esito = await invia({ tipo: 'invia', tabId: idScheda }) as
      { ok: boolean; status?: number; corpo?: Record<string, unknown>; errore?: string };
    ok('il relay accetta', esito.ok === true,
       esito.errore ?? `status ${esito.status} ${JSON.stringify(esito.corpo).slice(0, 140)}`);
    ok('otto squadre lette dai payload intercettati', esito.corpo?.squadre === 8);
    ok('copertura piena', esito.corpo?.copertura === 1);

    // --- 4. Il giornale esiste DAVVERO ------------------------------------
    const lettore = await ctx.newPage();
    const risposta = await lettore.goto(`${SERVER}/g/${publicSlug}/${GIORNATA}`);
    ok('il giornale e’ leggibile all’indirizzo pubblico', risposta?.status() === 200);
    const pezzi = await lettore.locator('article.art').count();
    ok('il giornale ha pezzi veri', pezzi >= 6, `${pezzi} pezzi`);
    ok('e’ la lega giusta', (await lettore.content()).includes('Lega dell’Estensione'));

    // --- 5. Ferma butta davvero -------------------------------------------
    await invia({ tipo: 'disarma', tabId: idScheda });
    const dopoStop = await invia({ tipo: 'stato', tabId: idScheda }) as
      { catturati: string[]; armato: boolean };
    ok('“Ferma” svuota la memoria e disarma',
       dopoStop.catturati.length === 0 && dopoStop.armato === false);

    await pagina.reload({ waitUntil: 'load' });
    await pagina.locator('#stato li').nth(4).waitFor({ timeout: 20_000 });
    const dopoRicarica = await invia({ tipo: 'stato', tabId: idScheda }) as { catturati: string[] };
    ok('e dopo “Ferma” non riprende da sola', dopoRicarica.catturati.length === 0);
  } finally {
    await ctx.close();
    await rm(profilo, { recursive: true, force: true });
    await pool?.end();
  }

  console.log(problemi.length === 0 ? '\nTUTTO OK' : `\nPROBLEMI: ${problemi.join(', ')}`);
  process.exit(problemi.length === 0 ? 0 : 1);
}

await main();
