/**
 * Estetica puramente TIPOGRAFICA: nessuna foto di calciatori.
 *
 * Non è una scelta di gusto ma di rischio: i diritti sulle immagini dei
 * calciatori di Serie A sono un campo minato che blocca la monetizzazione al
 * primo tentativo. Griglia a colonne, filetti, retino e font di sistema danno
 * un look da quotidiano più distintivo di qualunque foto stock, gratis e
 * legalmente pulito.
 */
export const NEWSPAPER_CSS = `
:root {
  --paper: #f4f1e8;
  --paper-alt: #eae5d8;
  --ink: #16130f;
  --ink-soft: #4a443a;
  --rule: #16130f;
  --accent: #8a1c1c;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  --grotesque: "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #14120e;
    --paper-alt: #1d1a15;
    --ink: #ece7dc;
    --ink-soft: #a49c8c;
    --rule: #6b6558;
    --accent: #e0685f;
  }
}
:root[data-theme="dark"] {
  --paper: #14120e; --paper-alt: #1d1a15; --ink: #ece7dc;
  --ink-soft: #a49c8c; --rule: #6b6558; --accent: #e0685f;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
.sheet { max-width: 1180px; margin: 0 auto; padding-block: 28px; padding-inline: 20px; }

/* ---------- Testata ---------- */
.masthead { text-align: center; border-bottom: 3px double var(--rule); padding-bottom: 14px; margin-bottom: 22px; }
.masthead::before {
  content: ""; display: block; border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule); height: 4px; margin-bottom: 16px;
}
.masthead__kicker, .byline, .list-title, .boxscore h3, caption, .card__label {
  font-family: var(--grotesque); text-transform: uppercase;
  letter-spacing: .14em; font-size: .66rem; color: var(--ink-soft);
}
.masthead__title {
  font-size: clamp(2.6rem, 9vw, 5.2rem); margin: .12em 0 .06em;
  letter-spacing: -.02em; font-weight: 800; line-height: .95;
}
.masthead__tagline { margin: 0; font-style: italic; color: var(--ink-soft); font-size: .95rem; }

/* ---------- Griglia ---------- */
.grid { display: grid; gap: 26px; grid-template-columns: 2fr 1fr; align-items: start; }
.stack { display: grid; gap: 26px; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }

.art { border-top: 1px solid var(--rule); padding-top: 14px; }
.art p { margin: 0 0 .72em; text-align: justify; hyphens: auto; }
.byline { margin: 0 0 .5em; }

.headline { font-size: 1.55rem; line-height: 1.12; margin: 0 0 .35em; letter-spacing: -.01em; }
.art--apertura .headline { font-size: clamp(2rem, 5.2vw, 3.1rem); }
.art--apertura .standfirst { font-size: 1.12rem; }
.standfirst { font-style: italic; color: var(--ink-soft); margin-bottom: .9em !important; }

/* Il corpo dell'apertura va su colonne come in un quotidiano vero. */
.art--apertura .art__body { column-count: 2; column-gap: 26px; column-rule: 1px solid var(--rule); }
@media (max-width: 760px) { .art--apertura .art__body { column-count: 1; } }

.pull-quote {
  margin: 1em 0; padding: .6em 0; border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule); break-inside: avoid;
}
.pull-quote p { font-size: 1.2rem; font-style: italic; margin: 0 0 .2em; text-align: left; }
.pull-quote cite { font-family: var(--grotesque); font-size: .7rem; text-transform: uppercase; letter-spacing: .1em; color: var(--ink-soft); font-style: normal; }

.interview .q { display: block; font-weight: 700; }
.interview .a { display: block; margin-bottom: .7em; }
.interview .intro { font-style: italic; color: var(--ink-soft); }

table { width: 100%; border-collapse: collapse; font-size: .9rem; }
caption { text-align: left; padding-bottom: .4em; }
.pagella th, .results td, .standings td, .boxscore th, .boxscore td { padding: .3em .4em; border-bottom: 1px solid var(--paper-alt); text-align: left; }
.pagella th { font-weight: 600; width: 32%; }
.pagella .vote { font-family: var(--grotesque); font-weight: 700; width: 3em; color: var(--accent); }
.results .score, .standings .pts, .results .pts { font-family: var(--grotesque); font-variant-numeric: tabular-nums; }
.results .score { text-align: center; font-weight: 700; }
.results .pts, .standings .pts { text-align: right; color: var(--ink-soft); }
.standings .pos { width: 2.4em; color: var(--ink-soft); }

.rubric-list { margin: 0; padding-left: 1.1em; }
.rubric-list li { margin-bottom: .45em; }
.list-title { margin: 0 0 .5em; }

.boxscore { background: var(--paper-alt); padding: 12px 14px; margin: 1em 0; break-inside: avoid; }
.boxscore h3 { margin: 0 0 .5em; }
.boxscore .source { font-size: .8rem; color: var(--ink-soft); font-style: italic; margin: .5em 0 0 !important; text-align: left !important; }

.panel { border: 1px solid var(--rule); padding: 14px; }
.panel + .panel { margin-top: 20px; }

/* ---------- Card personali ---------- */
.cards { margin-top: 34px; border-top: 3px double var(--rule); padding-top: 18px; }
.cards__grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
.card { border: 1px solid var(--rule); padding: 14px; display: flex; flex-direction: column; gap: .4em; }
.card--gloria { border-left: 5px solid var(--accent); }
.card--disfatta { border-left: 5px solid var(--ink-soft); }
.card--grigiore { border-left: 5px solid var(--paper-alt); }
.card__team { font-family: var(--grotesque); font-size: .68rem; text-transform: uppercase; letter-spacing: .12em; color: var(--ink-soft); }
.card__headline { font-size: 1.12rem; font-weight: 700; line-height: 1.2; margin: 0; }
.card__body { font-size: .92rem; margin: 0; }
.card__stat { margin-top: auto; padding-top: .5em; border-top: 1px solid var(--paper-alt); display: flex; align-items: baseline; gap: .4em; }
.card__value { font-family: var(--grotesque); font-size: 1.7rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--accent); }

.colophon { margin-top: 30px; padding-top: 12px; border-top: 1px solid var(--rule); font-family: var(--grotesque); font-size: .66rem; color: var(--ink-soft); line-height: 1.7; }
.badge { display: inline-block; border: 1px solid var(--ink-soft); padding: .1em .45em; margin-right: .4em; }
.notice { background: var(--accent); color: var(--paper); padding: .6em .9em; font-family: var(--grotesque); font-size: .78rem; margin-bottom: 18px; }
`;

/** Regole aggiuntive per il broadsheet stampato. */
export const PRINT_CSS = `
@page { size: A3 portrait; margin: 14mm; }
body { background: #fff; color: #000; font-size: 10.5pt; }
.sheet { max-width: none; padding: 0; }
.grid { grid-template-columns: 2fr 1fr; }
.art--apertura .art__body { column-count: 3; }
.art, .panel, .card, .boxscore, .pull-quote { break-inside: avoid; }
.masthead { break-after: avoid; }
.cards { break-before: page; }
.colophon { break-before: avoid; }
a { color: inherit; text-decoration: none; }
`;
