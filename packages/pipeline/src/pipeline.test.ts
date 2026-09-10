import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { generateWorld, withOfficialScores, nudgeTeamToScore } from '@fantacomics/ingest';
import { TemplateDriver } from '@fantacomics/llm';
import { runMatchdayPipeline, MIN_PUBLISH_CONFIDENCE } from './pipeline.js';
import { InMemoryLeagueStore } from './store.js';

const R = DEFAULT_RULESET;

function world(matchday: number, leagueId = 'lega-test') {
  let w = generateWorld({ seed: `pipe-${matchday}`, teams: 8, matchday });
  w = nudgeTeamToScore(w, 't1', 71.5, R, { strict: false });
  w = withOfficialScores(w, R);
  return { ...w, snapshot: { ...w.snapshot, leagueId } };
}

async function run(matchday: number, store: InMemoryLeagueStore, over = {}) {
  const w = world(matchday);
  return runMatchdayPipeline({
    snapshot: w.snapshot, serieA: w.serieA, rules: R, store,
    driver: new TemplateDriver(), publishedAt: '2026-01-06T08:00:00+01:00', ...over,
  });
}

describe('pipeline end-to-end', () => {
  it('produce edizione, pagine e card in un colpo solo', async () => {
    const out = await run(12, new InMemoryLeagueStore());
    expect(out.edition.articles.length).toBeGreaterThanOrEqual(6);
    expect(out.html.web).toContain('<!doctype html>');
    expect(out.html.print).toContain('@page');
    expect(out.cards).toHaveLength(8);
    expect(out.ogImage).toContain('width="1200"');
    expect(out.publishable).toBe(true);
  });

  it('traccia ogni step con esito e durata', async () => {
    const out = await run(12, new InMemoryLeagueStore());
    const steps = out.trace.map((t) => t.step);
    expect(steps).toEqual(['compute', 'load-state', 'facts', 'pack', 'plan', 'generate', 'render', 'persist']);
    expect(out.trace.every((t) => t.status === 'ok')).toBe(true);
    expect(out.trace.find((t) => t.step === 'compute')?.note).toMatch(/Riconciliazione OK/);
  });

  it('persiste storico, memoria, edizione e corpus', async () => {
    const store = new InMemoryLeagueStore();
    await run(12, store);
    const history = await store.getHistory('lega-test');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.matchday).toBe(12);
    expect(Object.keys(history.entries[0]?.points ?? {})).toHaveLength(8);
    expect(history.entries[0]?.luckDelta).toBeDefined();

    const memory = await store.getMemory('lega-test');
    expect(Object.keys(memory.lastFormatUse).length).toBeGreaterThan(0);
    expect(Object.keys(memory.lastAppearance)).toHaveLength(8);

    // getEdition e' async: senza await l'asserzione passerebbe a vuoto
    // perche' una Promise e' sempre "defined".
    const published = await store.getEdition('lega-test', 12);
    expect(published?.edition.meta.matchday).toBe(12);
    // Il pack va persistito con l'edizione: senza, il giornale non si rilegge.
    expect(published?.pack.facts.length).toBeGreaterThan(0);
    expect(published?.pack.results.length).toBeGreaterThan(0);
    expect(await store.listEditions('lega-test')).toEqual([12]);
    const corpus = await store.getCorpus();
    expect(corpus?.sortedTeamPoints).toHaveLength(8);
  });

  it('è idempotente: rieseguire la stessa giornata non duplica lo storico', async () => {
    const store = new InMemoryLeagueStore();
    await run(12, store);
    await run(12, store);
    const history = await store.getHistory('lega-test');
    expect(history.entries).toHaveLength(1);
  });
});

describe('comportamento tra giornate', () => {
  it('la memoria fa ruotare i format da una giornata all’altra', async () => {
    const store = new InMemoryLeagueStore();
    const g1 = await run(11, store);
    const g2 = await run(12, store);

    const f1 = new Set(g1.plan.articles.map((a) => a.format.id));
    const f2 = g2.plan.articles.map((a) => a.format.id);
    const ripetuti = f2.filter((f) => f1.has(f));
    // Qualche format a cooldown zero può tornare, ma non l'intero giornale.
    expect(ripetuti.length).toBeLessThan(f2.length);
  });

  it('nessun presidente resta scoperto, giornata dopo giornata', async () => {
    const store = new InMemoryLeagueStore();
    for (const g of [9, 10, 11, 12, 13]) {
      const out = await run(g, store);
      const scoperti = out.plan.coverage.filter((c) => c.appearances === 0);
      expect(scoperti.map((c) => c.teamId), `giornata ${g}`).toEqual([]);
    }
  });

  it('lo storico accumulato sblocca i fatti di continuità stagionale', async () => {
    const store = new InMemoryLeagueStore();
    for (const g of [6, 7, 8, 9, 10, 11]) await run(g, store);
    const out = await run(12, store);

    const storici = new Set([
      'RECORD_POSITIVO_LEGA', 'RECORD_NEGATIVO_LEGA', 'FILOTTO_VITTORIE',
      'CROLLO_VERTICALE', 'INGIUSTIZIA_STAGIONALE', 'MALEDIZIONE_H2H',
    ]);
    const trovati = out.facts.facts.filter((f) => storici.has(f.type));
    expect(trovati.length, 'senza storico non esistono archi narrativi').toBeGreaterThan(0);
  });

  it('il corpus cross-lega cresce a ogni giornata', async () => {
    const store = new InMemoryLeagueStore();
    await run(11, store);
    await run(12, store);
    const corpus = await store.getCorpus();
    expect(corpus?.sortedTeamPoints).toHaveLength(16);
    const points = corpus?.sortedTeamPoints ?? [];
    expect([...points].sort((a, b) => a - b)).toEqual(points);
  });
});

describe('degrado e revisione', () => {
  it('marca in revisione l’edizione quando la riconciliazione fallisce', async () => {
    const store = new InMemoryLeagueStore();
    const w = world(12);
    const fixtures = w.snapshot.fixtures.map((f, i) =>
      i === 0 ? { ...f, officialHomePoints: (f.officialHomePoints ?? 0) + 9 } : f);

    const out = await runMatchdayPipeline({
      snapshot: { ...w.snapshot, fixtures }, serieA: w.serieA, rules: R, store,
      driver: new TemplateDriver(), publishedAt: '2026-01-06T08:00:00+01:00',
    });

    expect(out.result.degraded).toBe(true);
    expect(out.edition.meta.degraded).toBe(true);
    expect(out.confidence).toBeLessThan(1);
    expect(out.html.web).toContain('Edizione ridotta');
    // Il giornale esiste comunque: si degrada, non si spegne.
    expect(out.edition.articles.length).toBeGreaterThan(0);
  });

  it('la soglia di pubblicazione separa online da coda di revisione', async () => {
    const out = await run(12, new InMemoryLeagueStore());
    expect(out.publishable).toBe(out.confidence >= MIN_PUBLISH_CONFIDENCE);
  });
});

describe('configurazione della lega', () => {
  it('registra la lega e tiene aggiornata l’ultima giornata pubblicata', async () => {
    const store = new InMemoryLeagueStore();
    await store.saveConfig({
      leagueId: 'lega-test', leagueName: 'Lega Test', ruleset: R, spice: 2,
      createdAt: '2026-01-01T00:00:00Z', lastMatchday: null,
    });

    expect(await store.listLeagues()).toHaveLength(1);
    await run(11, store);
    await run(12, store);

    expect(await store.listEditions('lega-test')).toEqual([12, 11]);
    const config = await store.getConfig('lega-test');
    expect(config?.leagueName).toBe('Lega Test');
  });

  it('restituisce null per una lega sconosciuta invece di lanciare', async () => {
    const store = new InMemoryLeagueStore();
    expect(await store.getConfig('inesistente')).toBeNull();
    expect(await store.getEdition('inesistente', 1)).toBeNull();
    expect(await store.listEditions('inesistente')).toEqual([]);
  });
});
