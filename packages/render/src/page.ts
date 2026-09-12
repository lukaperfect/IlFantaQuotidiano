import type { Edition, FactPack } from '@fantacomics/core';
import {
  buildContext, esc, nomeDelNumero, renderArticle, renderFixtures, renderMasthead,
  renderResults, renderStandings,
} from './html.js';
import { NEWSPAPER_CSS, PRINT_CSS } from './styles.js';

export type PageOptions = {
  /** id persona -> nome leggibile, per la firma del pezzo. */
  personaNames?: Record<string, string>;
  /** Aggiunge il CSS del broadsheet e forza il layout da stampa. */
  print?: boolean;
  /** Mostra in pagina versioni e confidenza: utile in revisione, non in produzione. */
  showColophon?: boolean;
};

const MAIN_SLOTS = new Set(['apertura', 'interno', 'taglio_basso', 'serie_a']);

export function renderPage(edition: Edition, pack: FactPack, opts: PageOptions = {}): string {
  const ctx = buildContext(edition, pack);
  const names = opts.personaNames ?? {};
  const persona = (id: string) => names[id] ?? id.replace(/_/g, ' ');

  const main = edition.articles.filter((a) => MAIN_SLOTS.has(a.slot));
  const aside = edition.articles.filter((a) => !MAIN_SLOTS.has(a.slot));

  const notice = edition.meta.degraded
    ? '<p class="notice">Edizione ridotta: i punteggi ufficiali non hanno riconciliato, quindi le analisi controfattuali sono state omesse.</p>'
    : '';

  const body = [
    '<div class="sheet">',
    renderMasthead(ctx),
    notice,
    '<div class="grid">',
    '<div class="stack">',
    ...main.map((a) => renderArticle(a, ctx, persona(a.persona))),
    '</div>',
    '<div class="stack">',
    /**
     * I pannelli si costruiscono solo se hanno contenuto. `filter(Boolean)`
     * piu' in basso scarta le stringhe vuote, ma non un `<div class="panel">`
     * che ne contiene una: un riquadro vuoto in pagina si vede.
     */
    ...[renderResults(ctx), renderFixtures(ctx), renderStandings(ctx)]
      .filter((t) => t !== '')
      .map((t) => `<div class="panel">${t}</div>`),
    ...aside.map((a) => renderArticle(a, ctx, persona(a.persona))),
    '</div>',
    '</div>',
    renderCardsSection(edition),
    opts.showColophon === false ? '' : renderColophon(edition),
    '</div>',
  ].filter(Boolean).join('\n');

  const title = `${edition.masthead.title} · ${edition.meta.leagueName} · ${nomeDelNumero(edition)}`;

  return [
    '<!doctype html>',
    '<html lang="it">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(edition.masthead.tagline)}">`,
    /**
     * Fuori dai motori di ricerca.
     *
     * L'indirizzo del giornale e' un segreto revocabile, e quella promessa
     * l'ho gia' dovuta difendere una volta dalle cache HTTP. I motori sono la
     * stessa minaccia con una memoria molto piu' lunga: basta che qualcuno
     * incolli il link in un forum perche' nomi, punteggi e sfottio' della lega
     * diventino cercabili per sempre — e rigenerare lo slug a quel punto non
     * revoca piu' niente, perche' il contenuto e' gia' altrove.
     */
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(edition.masthead.tagline)}">`,
    '<style>',
    NEWSPAPER_CSS,
    opts.print ? PRINT_CSS : '',
    '</style>',
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

export function renderWebPage(edition: Edition, pack: FactPack, opts: PageOptions = {}): string {
  return renderPage(edition, pack, { ...opts, print: false });
}

/** Stessa sorgente, stesso contenuto: cambia solo l'impaginazione. */
export function renderPrintPage(edition: Edition, pack: FactPack, opts: PageOptions = {}): string {
  return renderPage(edition, pack, { ...opts, print: true, showColophon: opts.showColophon ?? true });
}

function renderCardsSection(edition: Edition): string {
  if (edition.personalCards.length === 0) return '';
  const cards = edition.personalCards.map((c) => [
    `<div class="card card--${esc(c.tone)}">`,
    `<p class="card__team">${esc(c.teamName)}</p>`,
    `<h3 class="card__headline">${esc(c.headline)}</h3>`,
    `<p class="card__body">${esc(c.body)}</p>`,
    '<div class="card__stat">',
    `<span class="card__value">${esc(c.stat.value)}</span>`,
    `<span class="card__label">${esc(c.stat.label)}</span>`,
    '</div>',
    '</div>',
  ].join('\n')).join('\n');

  return [
    '<section class="cards">',
    '<p class="masthead__kicker">Una card per ogni presidente</p>',
    `<div class="cards__grid">${cards}</div>`,
    '</section>',
  ].join('\n');
}

function renderColophon(edition: Edition): string {
  const m = edition.meta;
  const models = Object.keys(m.models).join(', ') || 'nessuno';
  return [
    '<footer class="colophon">',
    `<span class="badge">fact engine ${esc(m.factEngineVersion)}</span>`,
    `<span class="badge">prompt ${esc(m.promptVersion)}</span>`,
    `<span class="badge">regolamento v${m.rulesetVersion}</span>`,
    `<span class="badge">confidenza ${m.confidence.toFixed(2)}</span>`,
    `<br>Modelli: ${esc(models)} · seed ${esc(m.selectorSeed)}`,
    '<br>Tutti i numeri di questa edizione sono calcolati dai dati ufficiali della lega e verificati automaticamente.',
    '</footer>',
  ].join('\n');
}
