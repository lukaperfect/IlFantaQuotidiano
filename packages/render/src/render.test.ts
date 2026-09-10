import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET, type Edition, type FactPack } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts, buildFactPack } from '@fantacomics/facts';
import { planEdition, emptyMemory, PERSONAS } from '@fantacomics/editorial';
import { generateEdition, TemplateDriver } from '@fantacomics/llm';
import { generateWorld, withOfficialScores, nudgeTeamToScore } from '@fantacomics/ingest';
import { renderWebPage, renderPrintPage } from './page.js';
import { renderBlock, buildContext, esc } from './html.js';
import { renderCardSvg, wrapText, cardsOf } from './card.js';

const R = DEFAULT_RULESET;

async function build(opts: { teamName?: string; degraded?: boolean } = {}): Promise<{ edition: Edition; pack: FactPack }> {
  let world = generateWorld({ seed: 'render', teams: 8, matchday: 12 });
  world = nudgeTeamToScore(world, 't1', 71.5, R);
  if (opts.teamName) {
    const teams = world.snapshot.teams.map((t, i) => (i === 0 ? { ...t, teamName: opts.teamName as string } : t));
    world = { ...world, snapshot: { ...world.snapshot, teams } };
  }
  world = withOfficialScores(world, R);
  const result = computeLeagueMatchday(world.snapshot, world.serieA, R);
  const out = generateFacts(result);
  const pack = buildFactPack(result, out);
  const plan = planEdition({
    facts: out.facts, teamIds: world.snapshot.teams.map((t) => t.teamId),
    matchday: 12, leagueId: world.snapshot.leagueId, memory: emptyMemory(), spice: 2,
  });
  const res = await generateEdition({
    plan, pack,
    teamNames: new Map(world.snapshot.teams.map((t) => [t.teamId, t.teamName])),
    driver: new TemplateDriver(),
    rulesetVersion: R.version,
    degraded: opts.degraded ?? false,
    publishedAt: '2026-01-06T08:00:00+01:00',
  });
  return { edition: res.edition, pack };
}

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

describe('escaping', () => {
  it('neutralizza HTML nei nomi scelti dagli utenti', () => {
    expect(esc('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(esc(`"pippo" & 'baudo'`)).toBe('&quot;pippo&quot; &amp; &#39;baudo&#39;');
  });

  it('non lascia passare markup da un nome squadra nella pagina', async () => {
    const { edition, pack } = await build({ teamName: '<script>alert(1)</script>Juve' });
    const html = renderWebPage(edition, pack, { personaNames });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('blocchi IR', () => {
  const ctx = () => buildContext(
    { meta: {}, masthead: {}, articles: [], personalCards: [] } as unknown as Edition,
    {
      leagueId: 'l', leagueName: 'L', matchday: 12, season: '2025-26', factEngineVersion: '1.0.0',
      results: [], standings: [],
      facts: [{
        id: 'f1', type: 'BEFFA_DECIMALE', matchday: 12, drama: 80, polarity: 'tragedia',
        rarityPercentile: null, subjects: [{ kind: 'team', id: 't1', display: 'T1' }],
        numbers: { punti: '71.5', scarto: '0.5' }, plain: 'Ha perso per 0.5.', evidence: [],
      }],
    } as FactPack,
  );

  it('il tabellino prende i numeri dal fact pack, non dal modello', () => {
    const html = renderBlock({ kind: 'boxscore', factId: 'f1', caption: 'I numeri' }, ctx());
    expect(html).toContain('71.5');
    expect(html).toContain('0.5');
    expect(html).toContain('I numeri');
  });

  it('un riferimento a un fatto inesistente non rompe la pagina', () => {
    expect(renderBlock({ kind: 'boxscore', factId: 'non-esiste', caption: 'x' }, ctx())).toBe('');
  });

  it('rende pagelle, liste e citazioni', () => {
    const c = ctx();
    expect(renderBlock({ kind: 'pagella', rows: [
      { subject: 'Tizio', vote: '4', note: 'Poteva evitare di schierarlo.' },
      { subject: 'Caio', vote: '8', note: 'Giornata perfetta senza sbavature.' },
    ] }, c)).toContain('<table class="pagella">');
    expect(renderBlock({ kind: 'list', title: 'Oroscopo', items: ['Uno', 'Due'] }, c)).toContain('<ul class="rubric-list">');
    expect(renderBlock({ kind: 'pull_quote', text: 'Una frase', attribution: 'Il presidente' }, c)).toContain('<cite>');
  });
});

describe('pagina web', () => {
  it('contiene testata, pezzi, tabellino, classifica e card', async () => {
    const { edition, pack } = await build();
    const html = renderWebPage(edition, pack, { personaNames });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('class="masthead"');
    expect(html).toContain('class="results"');
    expect(html).toContain('class="standings"');
    expect(html).toContain('class="cards__grid"');
    expect((html.match(/<article class="art/g) ?? []).length).toBe(edition.articles.length);
    expect(html).toContain('Giornata 12');
  });

  it('è responsive e consapevole del tema', async () => {
    const { edition, pack } = await build();
    const html = renderWebPage(edition, pack);
    expect(html).toContain('width=device-width');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('@media (max-width: 760px)');
  });

  it('firma i pezzi con il nome leggibile della voce', async () => {
    const { edition, pack } = await build();
    const html = renderWebPage(edition, pack, { personaNames });
    expect(html).toContain('class="byline"');
    expect(html).toMatch(/byline">(Il|Lo|L)\s?/);
  });

  it('avvisa in pagina quando l’edizione è ridotta', async () => {
    const sana = await build();
    expect(renderWebPage(sana.edition, sana.pack)).not.toContain('class="notice"');
    const rotta = await build({ degraded: true });
    const html = renderWebPage(rotta.edition, rotta.pack);
    expect(html).toContain('class="notice"');
    expect(html).toContain('Edizione ridotta');
  });

  it('la versione da stampa aggiunge il broadsheet senza cambiare il contenuto', async () => {
    const { edition, pack } = await build();
    const print = renderPrintPage(edition, pack, { personaNames });
    expect(print).toContain('@page');
    expect(print).toContain('size: A3 portrait');
    expect(print).toContain('column-count: 3');
    // Stesso numero di pezzi: cambia l'impaginazione, non la sorgente.
    const web = renderWebPage(edition, pack, { personaNames });
    expect((print.match(/<article class="art/g) ?? []).length)
      .toBe((web.match(/<article class="art/g) ?? []).length);
  });
});

describe('card social', () => {
  it('manda a capo il testo entro la larghezza', () => {
    const lines = wrapText('parola '.repeat(40).trim(), 900, 72, 0.55);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
  });

  it('non spezza mai una parola a metà', () => {
    const originale = 'antidisestablishmentarianismo e altre parole lunghe da mandare a capo';
    expect(wrapText(originale, 400, 40).join(' ').replace(/\s+/g, ' ')).toBe(originale);
  });

  it('produce un SVG valido nei tre formati', async () => {
    const { edition } = await build();
    const card = cardsOf(edition)[0];
    expect(card).toBeDefined();
    for (const format of ['feed', 'story', 'og'] as const) {
      const svg = renderCardSvg(card as NonNullable<typeof card>, format);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
  });

  it('usa le dimensioni giuste per feed, story e anteprima link', async () => {
    const { edition } = await build();
    const card = cardsOf(edition)[0] as NonNullable<ReturnType<typeof cardsOf>[0]>;
    expect(renderCardSvg(card, 'feed')).toContain('width="1080" height="1350"');
    expect(renderCardSvg(card, 'story')).toContain('width="1080" height="1920"');
    expect(renderCardSvg(card, 'og')).toContain('width="1200" height="630"');
  });

  it('neutralizza markup dentro la card', async () => {
    const svg = renderCardSvg({
      teamName: '</text><script>alert(1)</script>', headline: 'Titolo', body: 'Corpo della card.',
      statLabel: 'punti', statValue: '71.5', tone: 'disfatta', matchday: 12, leagueName: 'Lega',
    });
    // Il nome squadra viene reso maiuscolo prima dell'escape: si verifica
    // la proprieta' di sicurezza (nessun '<' grezzo), non la sua grafia.
    expect(svg).not.toMatch(/<script/i);
    expect(svg).toMatch(/&lt;\/text&gt;/i);
    const testoUtente = svg.slice(svg.indexOf('FANTACOMICS'));
    expect(testoUtente).not.toMatch(/>[^<]*<(?!\/?(text|tspan|line|rect|svg)\b)/i);
  });

  it('emette una card per ogni presidente', async () => {
    const { edition } = await build();
    expect(cardsOf(edition)).toHaveLength(edition.personalCards.length);
    expect(cardsOf(edition)).toHaveLength(8);
  });
});
