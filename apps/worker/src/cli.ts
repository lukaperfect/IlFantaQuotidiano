import { DEFAULT_RULESET } from '@fantacomics/core';
import {
  generateWorld, withOfficialScores, nudgeTeamToScore, injectGoldenBench,
} from '@fantacomics/ingest';
import { TemplateDriver, AnthropicDriver, type LlmDriver } from '@fantacomics/llm';
import { runMatchdayPipeline } from '@fantacomics/pipeline';
import { FileLeagueStore } from '@fantacomics/pipeline';
import { AssetRenderer, writeText } from './assets.js';

/**
 * Demo end-to-end: una stagione intera, giornata per giornata.
 *
 * Non è un giocattolo: fa girare esattamente la pipeline di produzione, con
 * la stessa persistenza e la stessa memoria editoriale. Serve a verificare
 * l'unica cosa che nessun test unitario può verificare — che alla quinta
 * giornata il giornale non si stia ripetendo.
 */

const R = DEFAULT_RULESET;

type Args = {
  outDir: string;
  matchdays: number;
  teams: number;
  assets: boolean;
  live: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
  };
  return {
    outDir: get('--out', 'out'),
    matchdays: Number(get('--giornate', '6')),
    teams: Number(get('--squadre', '8')),
    assets: argv.includes('--assets'),
    live: argv.includes('--live'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new FileLeagueStore(`${args.outDir}/stato`);

  let driver: LlmDriver = new TemplateDriver();
  if (args.live) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('--live richiede ANTHROPIC_API_KEY. Uso il driver template.');
    } else {
      driver = new AnthropicDriver();
      console.log('Driver: Anthropic (chiamate reali, costo reale).\n');
    }
  }

  const formatiUsati = new Map<string, number>();
  const vociUsate = new Map<string, number>();
  let costoTotale = 0;
  let ultimo: Awaited<ReturnType<typeof runMatchdayPipeline>> | null = null;

  for (let giornata = 1; giornata <= args.matchdays; giornata++) {
    let world = generateWorld({
      seed: `stagione-${giornata}`,
      teams: args.teams,
      matchday: giornata,
      scenarios: { formazioneNonSchierata: giornata % 3 === 0 },
    });
    // Uno scenario drammatico costruito, per avere sempre materiale di punta.
    if (giornata % 2 === 0) world = nudgeTeamToScore(world, 't1', 71.5, R, { strict: false });
    if (giornata % 3 === 1) world = injectGoldenBench(world, 't3', R);
    world = withOfficialScores(world, R);

    const out = await runMatchdayPipeline({
      snapshot: world.snapshot,
      serieA: world.serieA,
      rules: R,
      store,
      driver,
      publishedAt: `2026-01-${String(5 + giornata).padStart(2, '0')}T08:00:00+01:00`,
      batch: true,
    });

    for (const a of out.plan.articles) {
      formatiUsati.set(a.format.id, (formatiUsati.get(a.format.id) ?? 0) + 1);
      vociUsate.set(a.persona.id, (vociUsate.get(a.persona.id) ?? 0) + 1);
    }
    costoTotale += out.costUSD;
    ultimo = out;

    const scoperti = out.plan.coverage.filter((c) => c.appearances === 0).length;
    const ms = out.trace.reduce((s, t) => s + t.ms, 0);
    console.log(
      `G${String(giornata).padStart(2)} · ${String(out.facts.facts.length).padStart(3)} fatti · ` +
      `${out.plan.articles.length} pezzi · conf ${out.confidence.toFixed(2)} · ` +
      `scoperti ${scoperti} · ${ms}ms · ${out.publishable ? 'pubblicabile' : 'IN REVISIONE'}`,
    );
  }

  if (!ultimo) return;

  console.log('\n── Rotazione dei format su tutta la stagione simulata');
  const totalePezzi = [...formatiUsati.values()].reduce((a, b) => a + b, 0);
  console.log(`   ${formatiUsati.size} format distinti su ${totalePezzi} pezzi`);
  const piuUsato = [...formatiUsati.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`   il più ripetuto: ${piuUsato?.[0]} (${piuUsato?.[1]} volte)`);
  console.log(`   voci: ${vociUsate.size} distinte`);
  console.log(`\n── Costo LLM: $${costoTotale.toFixed(4)} per ${args.matchdays} edizioni`);

  await writeText(`${args.outDir}/giornale.html`, ultimo.html.web);
  await writeText(`${args.outDir}/giornale-stampa.html`, ultimo.html.print);
  for (const card of ultimo.cards) {
    await writeText(`${args.outDir}/card-${card.teamId}.svg`, card.svg);
  }
  await writeText(`${args.outDir}/og.svg`, ultimo.ogImage);
  console.log(`\nHTML e SVG scritti in ${args.outDir}/`);

  if (args.assets) {
    const renderer = new AssetRenderer({ executablePath: process.env.CHROMIUM_PATH });
    try {
      await renderer.pdf(ultimo.html.print, `${args.outDir}/giornale.pdf`);
      for (const card of ultimo.cards.slice(0, 3)) {
        await renderer.png(card.svg, `${args.outDir}/card-${card.teamId}.png`, { width: 1080, height: 1350 });
      }
      await renderer.screenshot(ultimo.html.web, `${args.outDir}/anteprima.png`);
      console.log('PDF e PNG generati.');
    } finally {
      await renderer.close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
