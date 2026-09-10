import type { Article, Edition, FactPack, NarrativeFact } from '@fantacomics/core';
import { EditionSchema } from '@fantacomics/core';
import type { EditorialPlan } from '@fantacomics/editorial';
import { FACT_ENGINE_VERSION } from '@fantacomics/facts';
import { PROMPT_VERSION } from './system-prompt.js';
import { FORMAT_BLOCK_KINDS } from './schema.js';
import { TemplateDriver } from './template-driver.js';
import { allowedNumbersFor, allowedNumbersForPack, checkGrounding, textOfBlocks, type GroundingReport } from './grounding.js';
import { totalCost, type CostBreakdown } from './cost.js';
import type { ArticleDraft, LlmDriver, SpiceLevel, Usage } from './driver.js';

export type GenerateOptions = {
  plan: EditorialPlan;
  pack: FactPack;
  teamNames: ReadonlyMap<string, string>;
  driver: LlmDriver;
  /** Ripiego quando il driver principale fallisce o sfora il grounding. */
  fallback?: LlmDriver;
  spice?: SpiceLevel;
  rulesetVersion: number;
  degraded: boolean;
  publishedAt?: string;
  batch?: boolean;
};

export type ArticleOutcome = {
  slot: string;
  formatId: string;
  attempts: number;
  usedFallback: boolean;
  grounding: GroundingReport;
  error?: string;
};

export type GenerateResult = {
  edition: Edition;
  outcomes: ArticleOutcome[];
  usages: (Usage | null)[];
  cost: CostBreakdown;
  /** Sotto soglia l'edizione va in revisione umana, non in pubblicazione. */
  confidence: number;
};

/** Formati che possono legittimamente citare tabellino e classifica. */
const TABLE_FORMATS = new Set(['tabellino_commentato']);

function allowedFor(pack: FactPack, facts: readonly NarrativeFact[], formatId: string): Set<string> {
  if (TABLE_FORMATS.has(formatId)) return allowedNumbersForPack(pack, facts);
  const allowed = allowedNumbersFor(facts, [String(pack.matchday), pack.season]);
  return allowed;
}

function correctionFor(report: GroundingReport): string {
  const bad = report.violations
    .filter((v) => v.severity === 'high')
    .map((v) => `"${v.raw}" in «${v.context}»`)
    .slice(0, 6);
  return [
    'Il pezzo precedente conteneva cifre che NON compaiono nei fatti forniti:',
    ...bad.map((b) => `- ${b}`),
    'Riscrivi il pezzo usando esclusivamente i numeri presenti nei fatti.',
    'Se una battuta richiede un numero che non hai, cambia battuta.',
  ].join('\n');
}

/**
 * Genera l'edizione.
 *
 * Il ciclo per ogni pezzo è: genera → verifica ogni cifra → se sfora, riprova
 * UNA volta con la correzione esplicita → se sfora ancora, ripiega sul driver
 * template. Il giornale esce sempre; quello che non esce mai è un numero
 * inventato.
 */
export async function generateEdition(opts: GenerateOptions): Promise<GenerateResult> {
  const { plan, pack, driver } = opts;
  const fallback = opts.fallback ?? new TemplateDriver();
  const spice = opts.spice ?? 2;

  const articles: Article[] = [];
  const outcomes: ArticleOutcome[] = [];
  const usages: (Usage | null)[] = [];

  for (const planned of plan.articles) {
    const allowed = allowedFor(pack, planned.facts, planned.format.id);
    const baseRequest = {
      slot: planned.slot,
      formatId: planned.format.id,
      formatLabel: planned.format.label,
      formatBrief: planned.format.brief,
      personaName: planned.persona.name,
      personaVoice: planned.persona.voice,
      facts: planned.facts,
      leagueName: pack.leagueName,
      matchday: pack.matchday,
      spice,
      allowedBlockKinds: FORMAT_BLOCK_KINDS[planned.format.id],
    };

    let attempts = 0;
    let usedFallback = false;
    let draft: ArticleDraft | null = null;
    let report: GroundingReport = { ok: true, checked: 0, violations: [] };
    let error: string | undefined;

    for (const correction of [undefined, 'retry'] as const) {
      attempts++;
      try {
        const req = correction === undefined
          ? baseRequest
          : { ...baseRequest, correction: correctionFor(report) };
        const candidate = await driver.article(req);
        const check = checkGrounding(textOfBlocks(candidate.blocks), allowed);
        draft = candidate;
        report = check;
        if (check.ok) break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        draft = null;
      }
    }

    if (!draft || !report.ok) {
      usedFallback = true;
      draft = await fallback.article(baseRequest);
      report = checkGrounding(textOfBlocks(draft.blocks), allowed);
    }

    usages.push(draft.usage);
    outcomes.push({ slot: planned.slot, formatId: planned.format.id, attempts, usedFallback, grounding: report, error });
    articles.push({
      slot: planned.slot,
      format: planned.format.id,
      persona: planned.persona.id,
      blocks: draft.blocks,
      factIds: planned.facts.map((f) => f.id),
    });
  }

  // --- Card personali ---
  const cardRequest = {
    leagueName: pack.leagueName,
    matchday: pack.matchday,
    spice,
    cards: plan.personalCards.map((c) => ({
      teamId: c.teamId,
      teamName: opts.teamNames.get(c.teamId) ?? c.teamId,
      fact: c.fact,
      tone: c.tone,
    })),
  };

  let cardsDraft;
  try {
    cardsDraft = await driver.personalCards(cardRequest);
    const allowed = allowedNumbersFor(plan.personalCards.map((c) => c.fact), [String(pack.matchday)]);
    if (!checkGrounding(cardsDraft.cards.map((c) => `${c.headline} ${c.body} ${c.statValue}`).join('\n'), allowed).ok) {
      cardsDraft = await fallback.personalCards(cardRequest);
    }
  } catch {
    cardsDraft = await fallback.personalCards(cardRequest);
  }
  usages.push(cardsDraft.usage);

  const toneById = new Map(plan.personalCards.map((c) => [c.teamId, c.tone]));
  const personalCards = cardsDraft.cards.map((c) => ({
    teamId: c.teamId,
    teamName: opts.teamNames.get(c.teamId) ?? c.teamId,
    headline: c.headline,
    body: c.body,
    stat: { label: c.statLabel, value: c.statValue },
    tone: toneById.get(c.teamId) ?? 'grigiore',
  }));

  const confidence = computeConfidence({ outcomes, plan, degraded: opts.degraded });
  const models: Record<string, string> = {};
  for (const u of usages) if (u) models[u.model] = u.model;
  if (Object.keys(models).length === 0) models.template = 'template';

  const edition = EditionSchema.parse({
    meta: {
      leagueId: pack.leagueId,
      leagueName: pack.leagueName,
      season: pack.season,
      matchday: pack.matchday,
      publishedAt: opts.publishedAt ?? new Date().toISOString(),
      factEngineVersion: FACT_ENGINE_VERSION,
      promptVersion: PROMPT_VERSION,
      rulesetVersion: opts.rulesetVersion,
      models,
      selectorSeed: plan.seed,
      confidence,
      degraded: opts.degraded,
    },
    masthead: {
      title: 'FantaComics',
      tagline: `${pack.leagueName} · Giornata ${pack.matchday}`.slice(0, 120),
    },
    articles,
    personalCards,
  });

  return {
    edition,
    outcomes,
    usages,
    cost: totalCost(usages, { batch: opts.batch }),
    confidence,
  };
}

/**
 * La confidenza dell'edizione. Sotto 0.6 non si pubblica: si mette in coda di
 * revisione. Nelle prime settimane la revisione è al 100% comunque — è così
 * che si costruisce il dataset di stile, non un ripiego.
 */
export function computeConfidence(args: {
  outcomes: readonly ArticleOutcome[];
  plan: EditorialPlan;
  degraded: boolean;
}): number {
  let score = 1;
  if (args.degraded) score -= 0.3;

  const total = Math.max(1, args.outcomes.length);
  const fallbacks = args.outcomes.filter((o) => o.usedFallback).length;
  score -= 0.45 * (fallbacks / total);

  const lowViolations = args.outcomes.reduce(
    (n, o) => n + o.grounding.violations.filter((v) => v.severity === 'low').length, 0,
  );
  score -= Math.min(0.15, lowViolations * 0.02);
  score -= Math.min(0.15, args.plan.warnings.length * 0.05);

  const uncovered = args.plan.coverage.filter((c) => c.appearances === 0).length;
  score -= Math.min(0.2, uncovered * 0.1);

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}
