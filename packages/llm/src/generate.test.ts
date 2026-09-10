import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET, EditionSchema } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts, buildFactPack } from '@fantacomics/facts';
import { planEdition, emptyMemory } from '@fantacomics/editorial';
import { generateWorld, withOfficialScores, nudgeTeamToScore } from '@fantacomics/ingest';
import { generateEdition, type GenerateOptions } from './generate.js';
import { TemplateDriver } from './template-driver.js';
import { SYSTEM_PROMPT, PROMPT_VERSION } from './system-prompt.js';
import { buildMessageParams, MODELS, DEFAULT_ROUTING } from './anthropic-driver.js';
import { articleJsonSchema } from './schema.js';
import type { ArticleDraft, ArticleRequest, CardRequest, CardsDraft, LlmDriver } from './driver.js';
import { costOf, totalCost, seasonProjection } from './cost.js';

const R = DEFAULT_RULESET;

function scenario() {
  let world = generateWorld({ seed: 'llm', teams: 8, matchday: 12, scenarios: { formazioneNonSchierata: true } });
  world = nudgeTeamToScore(world, 't1', 71.5, R);
  world = withOfficialScores(world, R);
  const result = computeLeagueMatchday(world.snapshot, world.serieA, R);
  const out = generateFacts(result);
  const pack = buildFactPack(result, out);
  const plan = planEdition({
    facts: out.facts,
    teamIds: world.snapshot.teams.map((t) => t.teamId),
    matchday: 12,
    leagueId: world.snapshot.leagueId,
    memory: emptyMemory(),
    spice: 2,
  });
  return {
    plan, pack, result,
    teamNames: new Map(world.snapshot.teams.map((t) => [t.teamId, t.teamName])),
  };
}

function options(over: Partial<GenerateOptions> = {}): GenerateOptions {
  const s = scenario();
  return {
    plan: s.plan, pack: s.pack, teamNames: s.teamNames,
    driver: new TemplateDriver(),
    rulesetVersion: R.version,
    degraded: s.result.degraded,
    publishedAt: '2026-01-06T08:00:00+01:00',
    ...over,
  };
}

/** Driver che inventa numeri. Se `fixOnRetry`, si corregge al secondo giro. */
class Hallucinator implements LlmDriver {
  readonly name = 'hallucinator';
  calls = 0;
  constructor(private readonly fixOnRetry: boolean) {}

  async article(req: ArticleRequest): Promise<ArticleDraft> {
    this.calls++;
    const clean = this.fixOnRetry && req.correction !== undefined;
    return {
      blocks: [
        { kind: 'headline', text: clean ? 'Il pezzo corretto' : 'Record storico da 999' },
        {
          kind: 'body',
          paragraphs: [
            clean
              ? 'Il pezzo riscritto senza inventare nulla, con la sola prosa e nessuna cifra fuori posto.'
              : 'Il pezzo inventato sostiene che siano stati realizzati 999 punti in una sola giornata memorabile.',
          ],
        },
      ],
      usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0, model: MODELS.sonnet },
      producedBy: this.name,
    };
  }

  async personalCards(req: CardRequest): Promise<CardsDraft> {
    return {
      cards: req.cards.map((c) => ({
        teamId: c.teamId, headline: `${c.teamName} da 4321`, body: 'Corpo della card con una cifra inventata: 4321 punti tondi.',
        statLabel: 'punti', statValue: '4321',
      })),
      usage: null, producedBy: this.name,
    };
  }
}

describe('generazione dell’edizione', () => {
  it('produce un’edizione valida con il driver template', async () => {
    const res = await generateEdition(options());
    expect(() => EditionSchema.parse(res.edition)).not.toThrow();
    expect(res.edition.articles.length).toBeGreaterThanOrEqual(6);
    expect(res.edition.personalCards.length).toBe(8);
    expect(res.edition.meta.promptVersion).toBe(PROMPT_VERSION);
    expect(res.edition.meta.degraded).toBe(false);
  });

  it('il driver template non può violare il grounding, per costruzione', async () => {
    const res = await generateEdition(options());
    for (const o of res.outcomes) {
      expect(o.grounding.violations.filter((v) => v.severity === 'high'), o.formatId).toEqual([]);
    }
    expect(res.confidence).toBeGreaterThan(0.7);
  });

  it('riprova una volta e accetta il pezzo corretto, senza ripiegare', async () => {
    const driver = new Hallucinator(true);
    const res = await generateEdition(options({ driver }));
    expect(res.outcomes.every((o) => o.usedFallback)).toBe(false);
    const corrected = res.outcomes.filter((o) => o.attempts === 2 && !o.usedFallback);
    expect(corrected.length).toBeGreaterThan(0);
  });

  it('ripiega sul template quando il modello continua a inventare', async () => {
    const driver = new Hallucinator(false);
    const res = await generateEdition(options({ driver }));
    expect(res.outcomes.every((o) => o.usedFallback)).toBe(true);
    expect(res.outcomes.every((o) => o.attempts === 2)).toBe(true);
    // Il giornale esce comunque, ma la confidenza crolla e va in revisione.
    expect(res.edition.articles.length).toBeGreaterThan(0);
    expect(res.confidence).toBeLessThan(0.6);
  });

  it('nessuna cifra inventata sopravvive nell’edizione finale', async () => {
    const res = await generateEdition(options({ driver: new Hallucinator(false) }));
    const testo = JSON.stringify(res.edition);
    expect(testo).not.toContain('999');
    expect(testo).not.toContain('4321');
  });

  it('abbassa la confidenza quando la riconciliazione è fallita', async () => {
    const sano = await generateEdition(options());
    const rotto = await generateEdition(options({ degraded: true }));
    expect(rotto.confidence).toBeLessThan(sano.confidence);
    expect(rotto.edition.meta.degraded).toBe(true);
  });
});

describe('prefisso congelato — invariante di cache', () => {
  it('il system prompt non contiene nulla di dinamico', () => {
    // Un anno, una data o un id nel system invalidano la cache a ogni richiesta:
    // nessun errore, solo la fattura che sale. Questo test è la guardia.
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{/);
    expect(SYSTEM_PROMPT).not.toMatch(/giornata\s+\d/i);
  });

  it('due richieste per leghe diverse condividono lo stesso prefisso, byte per byte', () => {
    const mk = (userText: string) => buildMessageParams({
      model: MODELS.opus, slot: 'apertura', schema: articleJsonSchema(),
      spice: 2, userText, maxTokens: 2048,
    });
    const a = mk('<contesto>lega: Alfa\ngiornata: 3</contesto>');
    const b = mk('<contesto>lega: Beta\ngiornata: 27</contesto>');
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(JSON.stringify(a.messages)).not.toBe(JSON.stringify(b.messages));
  });

  it('marca il prefisso con TTL di un’ora', () => {
    const p = buildMessageParams({
      model: MODELS.opus, slot: 'apertura', schema: articleJsonSchema(),
      spice: 2, userText: 'x', maxTokens: 2048,
    });
    const block = (p.system as { cache_control?: { ttl?: string } }[])[0];
    expect(block?.cache_control?.ttl).toBe('1h');
  });
});

describe('assemblaggio della richiesta', () => {
  it('manda la direttiva operatore sul canale system quando il modello lo supporta', () => {
    const p = buildMessageParams({
      model: MODELS.opus, slot: 'apertura', schema: articleJsonSchema(),
      spice: 3, userText: 'dati', maxTokens: 2048,
    });
    const roles = (p.messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['user', 'system']);
  });

  it('ripiega dentro il turno utente sui modelli che non lo supportano', () => {
    const p = buildMessageParams({
      model: MODELS.sonnet, slot: 'interno', schema: articleJsonSchema(),
      spice: 3, userText: 'dati', maxTokens: 2048,
    });
    const roles = (p.messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['user']);
    expect(JSON.stringify(p.messages)).toContain('direttiva_operatore');
  });

  it('non manda effort a Haiku, che non lo accetta', () => {
    const haiku = buildMessageParams({
      model: MODELS.haiku, slot: 'rubrica', schema: articleJsonSchema(),
      spice: 2, userText: 'x', maxTokens: 1024,
    }) as unknown as { output_config: { effort?: string }; thinking?: unknown };
    expect(haiku.output_config.effort).toBeUndefined();
    expect(haiku.thinking).toBeUndefined();

    const opus = buildMessageParams({
      model: MODELS.opus, slot: 'apertura', schema: articleJsonSchema(),
      spice: 2, userText: 'x', maxTokens: 1024,
    }) as unknown as { output_config: { effort?: string }; thinking?: { type: string } };
    expect(opus.output_config.effort).toBe('high');
    expect(opus.thinking?.type).toBe('adaptive');
  });

  it('instrada l’apertura sul modello migliore e le rubriche sul più economico', () => {
    expect(DEFAULT_ROUTING.apertura).toBe(MODELS.opus);
    expect(DEFAULT_ROUTING.rubrica).toBe(MODELS.haiku);
  });
});

describe('costi', () => {
  it('applica il moltiplicatore ridotto alle letture da cache', () => {
    const senzaCache = costOf({ inputTokens: 20000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: MODELS.sonnet });
    const conCache = costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 20000, cacheWriteTokens: 0, model: MODELS.sonnet });
    expect(conCache.totalUSD).toBeCloseTo(senzaCache.totalUSD * 0.1, 6);
  });

  it('il batch dimezza il conto', () => {
    const u = { inputTokens: 4000, outputTokens: 6000, cacheReadTokens: 20000, cacheWriteTokens: 0, model: MODELS.sonnet };
    expect(costOf(u, { batch: true }).totalUSD).toBeCloseTo(costOf(u).totalUSD / 2, 6);
  });

  it('somma più chiamate e proietta la stagione', () => {
    const t = totalCost([
      { inputTokens: 4000, outputTokens: 2500, cacheReadTokens: 20000, cacheWriteTokens: 0, model: MODELS.opus },
      { inputTokens: 3000, outputTokens: 5000, cacheReadTokens: 20000, cacheWriteTokens: 0, model: MODELS.sonnet },
      null,
    ], { batch: true });
    expect(t.totalUSD).toBeGreaterThan(0);
    const proj = seasonProjection(t.totalUSD, 500);
    expect(proj.totalSeasonUSD).toBeCloseTo(t.totalUSD * 38 * 500, 4);
  });
});

describe('modalità degradata — qualità del testo', () => {
  it('non ripete la stessa frase in occhiello e corpo', async () => {
    const res = await generateEdition(options());
    for (const article of res.edition.articles) {
      const standfirst = article.blocks.find((b) => b.kind === 'standfirst');
      if (!standfirst || standfirst.kind !== 'standfirst') continue;
      const bodyText = article.blocks
        .filter((b) => b.kind === 'body' || b.kind === 'list')
        .map((b) => (b.kind === 'body' ? b.paragraphs.join(' ') : b.items.join(' ')))
        .join(' ');
      const frase = standfirst.text.replace(/…$/, '').slice(0, 60);
      expect(bodyText, `pezzo ${article.format}`).not.toContain(frase);
    }
  });

  it('non usa elenchi puntati nell’apertura di prima pagina', async () => {
    const res = await generateEdition(options());
    const apertura = res.edition.articles.find((a) => a.slot === 'apertura');
    expect(apertura?.blocks.some((b) => b.kind === 'list')).toBe(false);
  });

  it('rende leggibili le etichette delle statistiche nelle card', async () => {
    const res = await generateEdition(options());
    for (const card of res.edition.personalCards) {
      expect(card.stat.label).not.toMatch(/[a-z][A-Z]/); // niente camelCase grezzo
    }
  });
});
