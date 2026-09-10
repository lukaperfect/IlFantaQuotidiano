import type { Article, Block, Edition, FactPack, NarrativeFact } from '@fantacomics/core';

/** Escaping obbligatorio: ogni nome squadra è testo scelto da un utente. */
export function esc(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type RenderContext = {
  edition: Edition;
  pack: FactPack;
  factsById: Map<string, NarrativeFact>;
};

export function buildContext(edition: Edition, pack: FactPack): RenderContext {
  return { edition, pack, factsById: new Map(pack.facts.map((f) => [f.id, f])) };
}

/**
 * Un blocco IR diventa HTML.
 *
 * Il `boxscore` è il caso interessante: non contiene numeri, referenzia un
 * fatto per id. I numeri li mette QUI il renderer leggendoli dal fact pack,
 * cioè dal database. Il modello non li tocca mai.
 */
export function renderBlock(block: Block, ctx: RenderContext): string {
  switch (block.kind) {
    case 'headline':
      return `<h2 class="headline">${esc(block.text)}</h2>`;

    case 'standfirst':
      return `<p class="standfirst">${esc(block.text)}</p>`;

    case 'body':
      return block.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n');

    case 'pull_quote':
      return [
        '<blockquote class="pull-quote">',
        `<p>${esc(block.text)}</p>`,
        block.attribution ? `<cite>${esc(block.attribution)}</cite>` : '',
        '</blockquote>',
      ].filter(Boolean).join('\n');

    case 'interview':
      return [
        '<div class="interview">',
        block.intro ? `<p class="intro">${esc(block.intro)}</p>` : '',
        ...block.qa.map((qa) =>
          `<p class="qa"><span class="q">${esc(qa.q)}</span><span class="a">${esc(qa.a)}</span></p>`),
        '</div>',
      ].filter(Boolean).join('\n');

    case 'pagella':
      return [
        '<table class="pagella">',
        '<tbody>',
        ...block.rows.map((r) =>
          `<tr><th scope="row">${esc(r.subject)}</th><td class="vote">${esc(r.vote)}</td><td>${esc(r.note)}</td></tr>`),
        '</tbody>',
        '</table>',
      ].join('\n');

    case 'list':
      return [
        block.title ? `<h3 class="list-title">${esc(block.title)}</h3>` : '',
        '<ul class="rubric-list">',
        ...block.items.map((i) => `<li>${esc(i)}</li>`),
        '</ul>',
      ].filter(Boolean).join('\n');

    case 'boxscore':
      return renderBoxscore(block.factId, block.caption, ctx);
  }
}

function renderBoxscore(factId: string, caption: string, ctx: RenderContext): string {
  const fact = ctx.factsById.get(factId);
  if (!fact) {
    // Un id inesistente non deve rompere la pagina: si degrada in silenzio.
    return '';
  }
  const rows = Object.entries(fact.numbers)
    .map(([k, v]) => `<tr><th scope="row">${esc(humanize(k))}</th><td>${esc(v)}</td></tr>`)
    .join('\n');
  return [
    '<aside class="boxscore">',
    caption ? `<h3>${esc(caption)}</h3>` : '',
    `<table><tbody>${rows}</tbody></table>`,
    `<p class="source">${esc(fact.plain)}</p>`,
    '</aside>',
  ].filter(Boolean).join('\n');
}

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

const HEAD_KINDS = new Set(['headline', 'standfirst']);

export function renderArticle(article: Article, ctx: RenderContext, personaName?: string): string {
  // Testata e occhiello restano fuori dal flusso a colonne: in un quotidiano
  // il titolo attraversa le colonne, non ci entra dentro.
  const head = article.blocks.filter((b) => HEAD_KINDS.has(b.kind));
  const body = article.blocks.filter((b) => !HEAD_KINDS.has(b.kind));

  return [
    `<article class="art art--${esc(article.slot)}" data-format="${esc(article.format)}">`,
    ...head.map((b) => renderBlock(b, ctx)),
    personaName ? `<p class="byline">${esc(personaName)}</p>` : '',
    '<div class="art__body">',
    ...body.map((b) => renderBlock(b, ctx)),
    '</div>',
    '</article>',
  ].filter(Boolean).join('\n');
}

/** Il tabellino della giornata: dati puri, nessun testo generato. */
export function renderResults(ctx: RenderContext): string {
  const rows = ctx.pack.results.map((r) => `
    <tr>
      <td class="team">${esc(r.homeTeam)}</td>
      <td class="score">${esc(r.homeGoals)} - ${esc(r.awayGoals)}</td>
      <td class="team">${esc(r.awayTeam)}</td>
      <td class="pts">${esc(r.homePoints)} · ${esc(r.awayPoints)}</td>
    </tr>`).join('');
  return `<table class="results"><caption>Risultati</caption><tbody>${rows}</tbody></table>`;
}

export function renderStandings(ctx: RenderContext): string {
  const rows = ctx.pack.standings.map((s) => `
    <tr>
      <td class="pos">${esc(s.position)}</td>
      <td class="team">${esc(s.teamName)}</td>
      <td class="pts">${esc(s.points)}</td>
    </tr>`).join('');
  return `<table class="standings"><caption>Classifica</caption><tbody>${rows}</tbody></table>`;
}

export function renderMasthead(ctx: RenderContext): string {
  const { edition } = ctx;
  return [
    '<header class="masthead">',
    `<p class="masthead__kicker">${esc(edition.meta.season)} · Giornata ${edition.meta.matchday}</p>`,
    `<h1 class="masthead__title">${esc(edition.masthead.title)}</h1>`,
    `<p class="masthead__tagline">${esc(edition.masthead.tagline)}</p>`,
    '</header>',
  ].join('\n');
}
