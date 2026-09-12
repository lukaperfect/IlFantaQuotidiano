import type { Article, Edition, FactPack, NarrativeFact } from '@fantacomics/core';
import { EditionSchema } from '@fantacomics/core';
import type { EditorialPlan } from '@fantacomics/editorial';
import { FACT_ENGINE_VERSION } from '@fantacomics/facts';
import { checkRepetition, type RepetitionReport } from '@fantacomics/editorial';
import { PROMPT_VERSION } from './system-prompt.js';
import { FORMAT_BLOCK_KINDS } from './schema.js';
import { TemplateDriver } from './template-driver.js';
import { allowedNumbersFor, allowedNumbersForPack, checkGrounding, textOfBlocks, type GroundingReport } from './grounding.js';
import { shingles } from '@fantacomics/editorial';
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
  /**
   * Gli n-grammi già usati nelle edizioni recenti della stessa lega.
   * Senza, il giornale può ripetersi con parole identiche pur cambiando
   * format — che è il modo più veloce di smettere di essere letto.
   */
  pastCorpus?: ReadonlySet<string>;
};

export type ArticleOutcome = {
  slot: string;
  formatId: string;
  attempts: number;
  usedFallback: boolean;
  grounding: GroundingReport;
  repetition: RepetitionReport;
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

function correctionFor(grounding: GroundingReport, repetition: RepetitionReport): string {
  const parti: string[] = [];

  const bad = grounding.violations
    .filter((v) => v.severity === 'high')
    .map((v) => `"${v.raw}" in «${v.context}»`)
    .slice(0, 6);
  if (bad.length > 0) {
    parti.push(
      'Il pezzo precedente conteneva cifre che NON compaiono nei fatti forniti:',
      ...bad.map((b) => `- ${b}`),
      'Riscrivi usando esclusivamente i numeri presenti nei fatti.',
      'Se una battuta richiede un numero che non hai, cambia battuta.',
    );
  }

  if (repetition.ripetuto) {
    parti.push(
      `Il pezzo precedente ricalcava edizioni passate della stessa lega (${Math.round(repetition.containment * 100)}% di frasi già usate).`,
      'Queste sequenze sono già state stampate e non vanno riusate:',
      ...repetition.frasiRipetute.map((f) => `- «${f}»`),
      'Riscrivi cambiando angolo e costruzione delle frasi, non solo qualche parola.',
    );
  }

  return parti.join('\n');
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
  /**
   * Copia mutabile che cresce con i pezzi accettati in questa stessa edizione.
   * Parte SEMPRE, anche senza edizioni passate: un primo numero con otto pezzi
   * identici fra loro e' grave quanto un numero che ricalca il precedente.
   */
  const corpus = new Set(opts.pastCorpus ?? []);

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
      kind: pack.kind,
      // Solo l'anteprima li ha: in un retrospettivo `fixtures` e' vuoto e il
      // tabellino sta nei fatti.
      fixtures: pack.fixtures,
      allowedBlockKinds: FORMAT_BLOCK_KINDS[planned.format.id],
    };

    let attempts = 0;
    let usedFallback = false;
    let draft: ArticleDraft | null = null;
    let report: GroundingReport = { ok: true, checked: 0, violations: [] };
    let ripetizione: RepetitionReport = { ripetuto: false, containment: 0, frasiRipetute: [] };
    let error: string | undefined;

    for (const correction of [undefined, 'retry'] as const) {
      attempts++;
      try {
        const req = correction === undefined
          ? baseRequest
          : { ...baseRequest, correction: correctionFor(report, ripetizione) };
        const candidate = await driver.article(req);
        const testo = textOfBlocks(candidate.blocks);
        draft = candidate;
        report = checkGrounding(testo, allowed);
        ripetizione = checkRepetition(testo, corpus);
        if (report.ok && !ripetizione.ripetuto) break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        draft = null;
      }
    }

    /**
     * Il ripiego scatta solo per il grounding, non per la ripetizione: un
     * pezzo che si ripete resta pubblicabile, uno con un numero inventato no.
     * La ripetizione abbassa la confidenza e finisce nella revisione, che e'
     * la risposta proporzionata a un difetto di stile.
     */
    if (!draft || !report.ok) {
      usedFallback = true;
      draft = await fallback.article(baseRequest);
      const testo = textOfBlocks(draft.blocks);
      report = checkGrounding(testo, allowed);
      ripetizione = checkRepetition(testo, corpus);
    }

    // Il pezzo appena accettato entra nel corpus: due pezzi della STESSA
    // edizione non devono somigliarsi fra loro.
    for (const s of shingles(textOfBlocks(draft.blocks))) corpus.add(s);

    usages.push(draft.usage);
    outcomes.push({
      slot: planned.slot, formatId: planned.format.id, attempts, usedFallback,
      grounding: report, repetition: ripetizione,
      ...(error ? { error } : {}),
    });
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
    kind: pack.kind,
    cards: plan.personalCards.map((c) => ({
      teamId: c.teamId,
      teamName: opts.teamNames.get(c.teamId) ?? c.teamId,
      fact: c.fact,
      tone: c.tone,
    })),
  };

  /**
   * NESSUNA CARD, NESSUNA CHIAMATA. Il piano di un'anteprima non produce card
   * (vedi il selettore), e chiedere al modello di scriverne zero costerebbe
   * comunque un giro completo di prompt per ricevere un elenco vuoto: su
   * settantasei uscite a stagione per lega e' spesa pura contro un prezzo di
   * 4,99 euro.
   */
  let cardsDraft: Awaited<ReturnType<LlmDriver['personalCards']>> = {
    cards: [], usage: null, producedBy: 'nessuna',
  };
  if (plan.personalCards.length === 0) {
    // Niente da generare: si salta, e non si registra nessun consumo.
  } else try {
    cardsDraft = await driver.personalCards(cardRequest);
    const allowed = allowedNumbersFor(plan.personalCards.map((c) => c.fact), [String(pack.matchday)]);
    if (!checkGrounding(cardsDraft.cards.map((c) => `${c.headline} ${c.body} ${c.statValue}`).join('\n'), allowed).ok) {
      cardsDraft = await fallback.personalCards(cardRequest);
    }
  } catch {
    cardsDraft = await fallback.personalCards(cardRequest);
  }
  if (plan.personalCards.length > 0) usages.push(cardsDraft.usage);

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
      // Il tipo viaggia dal pack ai metadati: da qui in poi l'edizione sa da
      // sola che numero e', senza bisogno del pack accanto.
      kind: pack.kind,
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
      /**
       * La testata dice quale dei due numeri e' questo. Non e' cosmetica: le
       * due uscite della settimana parlano della STESSA giornata, e un lettore
       * che trova due volte «Giornata 12» non sa quale ha in mano.
       */
      tagline: (pack.kind === 'anteprima'
        ? `${pack.leagueName} · Vigilia della giornata ${pack.matchday}`
        : `${pack.leagueName} · Giornata ${pack.matchday}`).slice(0, 120),
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

  // Un giornale che si ripete non è sbagliato, è noioso: pesa meno di un
  // ripiego ma abbastanza da finire in revisione se succede spesso.
  const ripetuti = args.outcomes.filter((o) => o.repetition.ripetuto).length;
  score -= Math.min(0.25, 0.12 * ripetuti);
  score -= Math.min(0.15, args.plan.warnings.length * 0.05);

  const uncovered = args.plan.coverage.filter((c) => c.appearances === 0).length;
  score -= Math.min(0.2, uncovered * 0.1);

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}
