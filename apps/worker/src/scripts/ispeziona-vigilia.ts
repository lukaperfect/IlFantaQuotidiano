/**
 * Come e' composto un numero di vigilia, slot per slot.
 *
 * Serve a rispondere alla domanda che un conteggio di pezzi non risponde: se un
 * giornale esce con sei pezzi invece di otto, QUALI due mancano. Due rubriche in
 * meno sono un giornale piu' asciutto; l'apertura in meno e' un giornale senza
 * prima pagina, e i due casi si contano allo stesso modo.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_RULESET, type LeagueRoster } from '@fantacomics/core';
import { importaRoseXlsx } from '@fantacomics/ingest';
import { InMemoryLeagueStore, runAnteprimaPipeline } from '@fantacomics/pipeline';
import { TemplateDriver } from '@fantacomics/llm';
import type { HistoricalMatchday } from '@fantacomics/facts';

const qui = dirname(fileURLToPath(import.meta.url));
const esito = importaRoseXlsx(readFileSync(
  join(qui, '../../../../packages/ingest/src/__fixtures__/rose-leghe-fantacalcio.xlsx'),
));
const roster: LeagueRoster = {
  season: '2025-26', importedAt: new Date().toISOString(), source: 'xlsx-rose',
  teams: esito.squadre.map((s) => ({
    teamId: s.teamId, teamName: s.teamName, players: s.giocatori,
  })),
};

const ids = roster.teams.map((t) => t.teamId);
const calendario: { homeTeamId: string; awayTeamId: string }[] = [];
for (let i = 0; i + 1 < ids.length; i += 2) {
  calendario.push({ homeTeamId: ids[i] as string, awayTeamId: ids[i + 1] as string });
}

/**
 * Uno storico sintetico plausibile: ogni giornata accoppia le squadre a coppie
 * e assegna esiti deterministici, cosi' che strisce e crisi esistano davvero.
 */
function storico(giornate: number): { entries: HistoricalMatchday[] } {
  const entries: HistoricalMatchday[] = [];
  for (let g = 1; g <= giornate; g++) {
    const points: Record<string, number> = {};
    const results: Record<string, 'W' | 'D' | 'L'> = {};
    const opponents: Record<string, string> = {};
    const positions: Record<string, number> = {};
    ids.forEach((id, i) => {
      const avversario = ids[i % 2 === 0 ? i + 1 : i - 1] ?? ids[0] as string;
      opponents[id] = avversario;
      points[id] = 60 + ((i * 7 + g * 3) % 25);
      // Le prime tre vincono sempre: serve una striscia da raccontare.
      results[id] = i < 3 ? 'W' : i < 6 ? 'L' : (g % 2 === 0 ? 'D' : 'W');
      positions[id] = i + 1;
    });
    entries.push({ matchday: g, points, results, opponents, positions });
  }
  return { entries };
}

async function prova(
  nome: string, fixtures: typeof calendario, giornateGiocate = 0,
): Promise<void> {
  const store = new InMemoryLeagueStore();
  await store.saveConfig({
    leagueId: 'l', ownerId: 'a', publicSlug: 'slug-di-prova-lungo', relaySecret: null,
    leagueName: 'Lega', ruleset: DEFAULT_RULESET, spice: 2,
    createdAt: new Date().toISOString(), lastMatchday: null,
  });
  const st = storico(giornateGiocate);
  for (const e of st.entries) await store.appendHistory('l', e);
  const out = await runAnteprimaPipeline({
    leagueId: 'l', leagueName: 'Lega', roster, matchday: giornateGiocate + 1, fixtures, store,
    rulesetVersion: DEFAULT_RULESET.version,
    driver: new TemplateDriver(), fallback: new TemplateDriver(),
  });
  console.log(`\n=== ${nome}: ${out.facts.facts.length} fatti -> ${out.edition.articles.length} pezzi, confidenza ${out.confidence}`);
  for (const a of out.edition.articles) {
    console.log(`  ${a.slot.padEnd(13)} ${a.format.padEnd(22)} ${String(a.factIds.length).padStart(2)} fatti  ${a.persona}`);
  }
  console.log('  fatti per drama:');
  for (const f of out.facts.facts.slice(0, 6)) {
    console.log(`    [${String(f.drama).padStart(3)}] ${f.type}`);
  }
  const asta = new Set([
    'RE_DELL_ASTA', 'PEZZO_PREGIATO', 'ASTA_AL_RISPARMIO',
    'ATTACCO_PIU_COSTOSO', 'PORTA_LOW_COST', 'ASTA_SPALMATA',
  ]);
  const inPagina = out.plan.articles.flatMap((a) => a.facts);
  const quotaAsta = inPagina.filter((f) => asta.has(f.type)).length / Math.max(1, inPagina.length);
  console.log(`  quota di asta nel giornale: ${Math.round(quotaAsta * 100)}%`);
  if (out.plan.warnings.length) console.log(`  avvisi: ${out.plan.warnings.join(' | ')}`);
}

await prova('giornata 1, senza calendario', []);
await prova('giornata 1, con calendario', calendario);
await prova('giornata 6, con calendario e storico', calendario, 5);
await prova('giornata 16, con calendario e storico', calendario, 15);
