import { writeFileSync, mkdirSync } from 'node:fs';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts, buildFactPack } from '@fantacomics/facts';
import { planEdition, emptyMemory, PERSONAS } from '@fantacomics/editorial';
import { generateEdition, TemplateDriver } from '@fantacomics/llm';
import { renderWebPage, renderPrintPage, renderCardSvg, cardsOf } from '@fantacomics/render';
import { generateWorld, withOfficialScores, nudgeTeamToScore, injectGoldenBench } from '@fantacomics/ingest';

const R = DEFAULT_RULESET;
const outDir = process.argv[2] ?? 'tmp-out';
mkdirSync(outDir, { recursive: true });

let world = generateWorld({ seed: 'giornata-12', teams: 8, matchday: 12, scenarios: { formazioneNonSchierata: true } });
world = nudgeTeamToScore(world, 't1', 71.5, R);
world = nudgeTeamToScore(world, 't2', 72, R);
world = injectGoldenBench(world, 't3', R);
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
  degraded: result.degraded,
  publishedAt: '2026-01-06T08:00:00+01:00',
});

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));
writeFileSync(`${outDir}/giornale.html`, renderWebPage(res.edition, pack, { personaNames }));
writeFileSync(`${outDir}/giornale-stampa.html`, renderPrintPage(res.edition, pack, { personaNames }));
const cards = cardsOf(res.edition);
cards.forEach((c, i) => writeFileSync(`${outDir}/card-${i + 1}.svg`, renderCardSvg(c, 'feed')));
if (cards[0]) writeFileSync(`${outDir}/og.svg`, renderCardSvg(cards[0], 'og'));

console.log(`Edizione: ${res.edition.articles.length} pezzi, ${cards.length} card, confidenza ${res.confidence}`);
console.log(`Scritti in ${outDir}/`);
