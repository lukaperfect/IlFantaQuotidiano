import { DEFAULT_RULESET } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts } from '@fantacomics/facts';
import { planEdition, emptyMemory } from '@fantacomics/editorial';
import { generateWorld, withOfficialScores, nudgeTeamToScore, injectGoldenBench } from '@fantacomics/ingest';

const R = DEFAULT_RULESET;
let world = generateWorld({ seed: 'giornata-12', teams: 8, matchday: 12, scenarios: { formazioneNonSchierata: true } });
world = nudgeTeamToScore(world, 't1', 71.5, R);
world = nudgeTeamToScore(world, 't2', 72, R);
world = injectGoldenBench(world, 't3', R);
world = withOfficialScores(world, R);

const result = computeLeagueMatchday(world.snapshot, world.serieA, R);
const out = generateFacts(result);
const plan = planEdition({
  facts: out.facts,
  teamIds: world.snapshot.teams.map((t) => t.teamId),
  matchday: 12,
  leagueId: world.snapshot.leagueId,
  memory: emptyMemory(),
  spice: 2,
});

for (const a of plan.articles) {
  console.log(`\n── ${a.slot.toUpperCase()} · ${a.format.label} · voce: ${a.persona.name}`);
  for (const f of a.facts) console.log(`   • ${f.plain}`);
}
console.log('\n── CARD PERSONALI');
for (const c of plan.personalCards) {
  const name = c.fact.subjects.find((s) => s.id === c.teamId)?.display ?? c.teamId;
  console.log(`   [${c.tone.padEnd(9)}] ${name}: ${c.fact.plain}`);
}
console.log('\nAvvisi:', plan.warnings.length === 0 ? 'nessuno' : plan.warnings);
