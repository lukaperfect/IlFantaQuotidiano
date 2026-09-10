import {
  safeName,
  type Edition, type FactPack, type LeagueRuleset, type LeagueWeekSnapshot,
  type SerieAMatchday,
} from '@fantacomics/core';
import { computeLeagueMatchday, type LeagueMatchdayResult } from '@fantacomics/scoring';
import { generateFacts, buildFactPack, buildHistoryEntry, type FactEngineOutput } from '@fantacomics/facts';
import {
  planEdition, updateMemory, buildPastCorpus, PERSONAS,
  type EditorialPlan, type SpiceLevel,
} from '@fantacomics/editorial';
import { generateEdition, TemplateDriver, textOfEdition, type LlmDriver } from '@fantacomics/llm';
import { renderWebPage, renderPrintPage, renderCardSvg, cardsOf } from '@fantacomics/render';
import { MIN_PUBLISH_CONFIDENCE, type LeagueStore } from './store.js';

/**
 * LA PIPELINE.
 *
 * Sette step, ciascuno una funzione con input e output espliciti e nessuno
 * stato nascosto. Non è pedanteria: è ciò che rende l'orchestrazione
 * PORTABILE. Oggi girano in sequenza qui dentro; domani ognuno diventa uno
 * step di un workflow durabile con retry e osservabilità propri, e la
 * migrazione è un lavoro di giorni perché gli step non sanno di essere
 * orchestrati.
 */

export type StepTrace = {
  step: string;
  ms: number;
  status: 'ok' | 'saltato' | 'errore';
  note?: string;
};

export type PipelineInput = {
  snapshot: LeagueWeekSnapshot;
  serieA: SerieAMatchday;
  rules: LeagueRuleset;
  store: LeagueStore;
  driver?: LlmDriver;
  fallback?: LlmDriver;
  spice?: SpiceLevel;
  targetArticles?: number;
  publishedAt?: string;
  batch?: boolean;
  /** Quante edizioni passate confrontare per l'anti-ripetizione. */
  repetitionLookback?: number;
};

export type PipelineOutput = {
  result: LeagueMatchdayResult;
  facts: FactEngineOutput;
  pack: FactPack;
  plan: EditorialPlan;
  edition: Edition;
  html: { web: string; print: string };
  cards: { teamId: string; svg: string }[];
  ogImage: string;
  trace: StepTrace[];
  confidence: number;
  costUSD: number;
  /** Falso quando l'edizione va in coda di revisione invece che online. */
  publishable: boolean;
};

const personaNames = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));

export async function runMatchdayPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const trace: StepTrace[] = [];
  const timed = async <T>(step: string, fn: () => Promise<T> | T, note?: string): Promise<T> => {
    const t0 = performance.now();
    try {
      const out = await fn();
      trace.push({ step, ms: Math.round(performance.now() - t0), status: 'ok', ...(note ? { note } : {}) });
      return out;
    } catch (e) {
      trace.push({
        step, ms: Math.round(performance.now() - t0), status: 'errore',
        note: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };

  const leagueId = input.snapshot.leagueId;

  // 1. Calcolo e riconciliazione. Se i numeri non tornano, il resto si degrada
  //    invece di pubblicare un giornale "quasi giusto".
  const result = await timed('compute', () =>
    computeLeagueMatchday(input.snapshot, input.serieA, input.rules),
  );
  trace[trace.length - 1]!.note = result.reconciliation.message;

  // 2. Storico e corpus: la memoria che trasforma output isolati in narrazione.
  const [history, corpus, memory] = await timed('load-state', async () =>
    Promise.all([
      input.store.getHistory(leagueId),
      input.store.getCorpus(),
      input.store.getMemory(leagueId),
    ]),
  );

  /**
   * 3. Il testo delle edizioni recenti.
   *
   * Il cooldown su fatti e format impedisce di raccontare le stesse cose;
   * questo impedisce di raccontarle con le stesse parole. Senza, il giornale
   * si ripete pur cambiando format — ed e' cosi' che smette di essere letto.
   */
  const lookback = input.repetitionLookback ?? 3;
  const pastCorpus = await timed('past-text', async () => {
    const matchdays = (await input.store.listEditions(leagueId))
      .filter((n) => n !== input.snapshot.matchday)
      .slice(0, lookback);
    const testi: string[] = [];
    for (const n of matchdays) {
      const past = await input.store.getEdition(leagueId, n);
      if (past) testi.push(textOfEdition(past.edition));
    }
    return buildPastCorpus(testi);
  });
  trace[trace.length - 1]!.note = `${pastCorpus.size} n-grammi da ${lookback} edizioni`;

  // 4. Fatti deterministici.
  const facts = await timed('facts', () => generateFacts(result, { history, corpus }));
  trace[trace.length - 1]!.note = `${facts.facts.length} fatti`;

  const pack = await timed('pack', () => buildFactPack(result, facts));

  // 5. Piano editoriale: cosa si racconta, con quale format e quale voce.
  const plan = await timed('plan', () => planEdition({
    facts: facts.facts,
    teamIds: input.snapshot.teams.map((t) => t.teamId),
    matchday: input.snapshot.matchday,
    leagueId,
    memory,
    spice: input.spice ?? 2,
    ...(input.targetArticles !== undefined ? { targetArticles: input.targetArticles } : {}),
  }));
  trace[trace.length - 1]!.note = `${plan.articles.length} pezzi, ${plan.warnings.length} avvisi`;

  // 6. Generazione, con verifica di ogni cifra e ripiego garantito.
  const generated = await timed('generate', () => generateEdition({
    plan, pack,
    // safeName anche qui: i nomi passano dal motore dei fatti gia' sanificati,
    // ma le card li prendono dallo snapshot e sarebbero l'unico percorso verso
    // il modello privo del controllo. Un controllo applicato quasi ovunque
    // vale quanto il buco che lascia, e questo era il buco.
    teamNames: new Map(input.snapshot.teams.map((t) => [t.teamId, safeName(t.teamName)])),
    driver: input.driver ?? new TemplateDriver(),
    ...(input.fallback ? { fallback: input.fallback } : {}),
    spice: input.spice ?? 2,
    rulesetVersion: input.rules.version,
    degraded: result.degraded,
    pastCorpus,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.batch !== undefined ? { batch: input.batch } : {}),
  }));
  const ripieghi = generated.outcomes.filter((o) => o.usedFallback).length;
  const ripetuti = generated.outcomes.filter((o) => o.repetition.ripetuto).length;
  trace[trace.length - 1]!.note =
    `confidenza ${generated.confidence}, ${ripieghi} ripieghi, ${ripetuti} pezzi ripetitivi`;

  // 7. Rendering: una sorgente, tre uscite.
  const rendered = await timed('render', () => {
    const cards = cardsOf(generated.edition);
    return {
      web: renderWebPage(generated.edition, pack, { personaNames }),
      print: renderPrintPage(generated.edition, pack, { personaNames }),
      cards: generated.edition.personalCards.map((c, i) => ({
        teamId: c.teamId,
        svg: renderCardSvg(cards[i] as NonNullable<(typeof cards)[number]>, 'feed'),
      })),
      og: cards[0] ? renderCardSvg(cards[0], 'og') : '',
    };
  });

  // 8. Persistenza. Va DOPO il rendering: se il rendering fallisce, la memoria
  //    non avanza e rieseguire la giornata riparte da uno stato pulito.
  await timed('persist', async () => {
    await input.store.appendHistory(leagueId, buildHistoryEntry(result, facts));
    await input.store.saveMemory(leagueId, updateMemory(memory, {
      matchday: input.snapshot.matchday,
      factTypes: plan.articles.flatMap((a) => a.facts.map((f) => f.type)),
      formatIds: plan.articles.map((a) => a.format.id),
      personaIds: plan.articles.map((a) => a.persona.id),
      appearances: appearancesOf(plan),
    }));
    await input.store.saveEdition(leagueId, generated.edition, pack);
    await input.store.addToCorpus([...result.scores.values()].map((s) => s.total));
  });

  return {
    result, facts, pack, plan,
    edition: generated.edition,
    html: { web: rendered.web, print: rendered.print },
    cards: rendered.cards,
    ogImage: rendered.og,
    trace,
    confidence: generated.confidence,
    costUSD: generated.cost.totalUSD,
    publishable: generated.confidence >= MIN_PUBLISH_CONFIDENCE,
  };
}

function appearancesOf(plan: EditorialPlan): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const article of plan.articles) {
    for (const fact of article.facts) {
      for (const subject of fact.subjects) {
        if (subject.kind !== 'team') continue;
        (out[subject.id] ??= []).push(fact.polarity);
      }
    }
  }
  return out;
}
