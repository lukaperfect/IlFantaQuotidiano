import { DEFAULT_RULESET } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts } from '@fantacomics/facts';
import { generateWorld, withOfficialScores, nudgeTeamToScore, injectGoldenBench } from '@fantacomics/ingest';

const R = DEFAULT_RULESET;
let world = generateWorld({
  seed: process.argv[2] ?? 'giornata-12',
  teams: 8, matchday: 12,
  scenarios: { formazioneNonSchierata: true },
});
world = nudgeTeamToScore(world, 't1', 71.5, R);   // la beffa
world = nudgeTeamToScore(world, 't2', 72, R);     // l'avversario che ce la fa
world = injectGoldenBench(world, 't3', R);
world = withOfficialScores(world, R);

const result = computeLeagueMatchday(world.snapshot, world.serieA, R);
console.log('RICONCILIAZIONE:', result.reconciliation.message, '\n');

const out = generateFacts(result);
console.log(`FATTI: ${out.facts.length}\n`);
for (const f of out.facts.slice(0, 20)) {
  console.log(`[${String(f.drama).padStart(3)}] ${f.plain}`);
}
