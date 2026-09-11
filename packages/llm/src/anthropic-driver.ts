import Anthropic from '@anthropic-ai/sdk';
import type { Block, NarrativeFact, Slot } from '@fantacomics/core';
import { ArticleSchema } from '@fantacomics/core';
import { z } from 'zod';
import { PROMPT_VERSION, SYSTEM_PROMPT, spiceDirective } from './system-prompt.js';
import { articleJsonSchema, personalCardsJsonSchema, FORMAT_BLOCK_KINDS } from './schema.js';
import type {
  ArticleDraft, ArticleRequest, CardDraft, CardRequest, CardsDraft, LlmDriver, Usage,
} from './driver.js';

export const MODELS = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;

/**
 * Routing per criticità, non downgrade generalizzato.
 * L'apertura è il pezzo che la gente fotografa e incolla nel gruppo: lì la
 * qualità È il prodotto. Le rubriche sono micro-testi ad alto volume.
 */
/**
 * IL ROUTING E' UNA DECISIONE DI PREZZO, NON DI GUSTO.
 *
 * Misurato sui prompt veri (8 pezzi, prefisso di sistema 1095 token, 2601 di
 * input, ~3200 di uscita) e sul listino, per una lega a 4,99€ con due edizioni
 * a settimana per 38 giornate — 76 edizioni:
 *
 *   tutto opus                   3,77€/stagione   →  IN PERDITA
 *   sonnet tranne le rubriche    1,41€/stagione   →  72% di margine
 *   tutto haiku                  0,75€/stagione   →  85% di margine
 *
 * Opus e' fuori: da solo si mangia il ricavo. Fra le altre due la differenza e'
 * 0,66€ per lega a stagione, e non vale la pena risparmiarla sui pezzi che la
 * gente legge davvero — la promessa del prodotto e' «goliardici ma scritti
 * molto bene». Le rubriche sono pezzi corti di contorno: li' Haiku basta.
 *
 * Le cifre valgono con il prefisso cachato e le richieste in batch. Senza
 * batch raddoppiano e il margine resta comunque sopra il 40%: il batch e' una
 * comodita', non il perno del modello di costo.
 */
export const DEFAULT_ROUTING: Record<Slot, string> = {
  apertura: MODELS.sonnet,
  spalla: MODELS.sonnet,
  serie_a: MODELS.sonnet,
  interno: MODELS.sonnet,
  taglio_basso: MODELS.sonnet,
  rubrica: MODELS.haiku,
};

const EFFORT: Partial<Record<Slot, 'low' | 'medium' | 'high' | 'xhigh' | 'max'>> = {
  apertura: 'high', spalla: 'high', serie_a: 'high',
  interno: 'medium', taglio_basso: 'medium',
};

/** Solo alcuni modelli accettano istruzioni operatore a metà conversazione. */
const SUPPORTS_MIDCONV_SYSTEM = new Set<string>([MODELS.opus]);
/** `effort` non è accettato da Haiku 4.5. */
const SUPPORTS_EFFORT = new Set<string>([MODELS.opus, MODELS.sonnet]);
/** Haiku 4.5 usa ancora `budget_tokens`: qui il pensiero non serve, si omette. */
const SUPPORTS_ADAPTIVE_THINKING = new Set<string>([MODELS.opus, MODELS.sonnet]);

export type AnthropicDriverOptions = {
  client?: Anthropic;
  routing?: Partial<Record<Slot, string>>;
  maxTokens?: number;
};

const CardsResponse = z.object({
  cards: z.array(z.object({
    teamId: z.string(),
    headline: z.string(),
    body: z.string(),
    statLabel: z.string(),
    statValue: z.string(),
  })),
});

export class AnthropicDriver implements LlmDriver {
  readonly name = `anthropic:${PROMPT_VERSION}`;
  private readonly client: Anthropic;
  private readonly routing: Record<Slot, string>;
  private readonly maxTokens: number;

  constructor(opts: AnthropicDriverOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.routing = { ...DEFAULT_ROUTING, ...opts.routing };
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  async article(req: ArticleRequest): Promise<ArticleDraft> {
    const model = this.routing[req.slot] ?? MODELS.sonnet;
    const kinds = req.allowedBlockKinds ?? FORMAT_BLOCK_KINDS[req.formatId];
    const schema = articleJsonSchema(kinds);

    const response = await this.client.messages.create(
      this.buildRequest({
        model,
        slot: req.slot,
        schema,
        spice: req.spice,
        userText: buildArticlePrompt(req),
      }),
    );

    const parsed = parseJson(response);
    const blocks = z.object({ blocks: z.array(z.unknown()) }).parse(parsed).blocks;
    // La validazione vera è Zod sull'IR: lo schema JSON guida il modello,
    // non lo garantisce.
    const article = ArticleSchema.parse({
      slot: req.slot,
      format: req.formatId,
      persona: req.personaName,
      blocks,
      factIds: req.facts.map((f) => f.id),
    });

    return { blocks: article.blocks as Block[], usage: usageOf(response, model), producedBy: this.name };
  }

  async personalCards(req: CardRequest): Promise<CardsDraft> {
    const model = MODELS.haiku;
    const response = await this.client.messages.create(
      this.buildRequest({
        model,
        slot: 'rubrica',
        schema: personalCardsJsonSchema(),
        spice: req.spice,
        userText: buildCardsPrompt(req),
      }),
    );
    const cards = CardsResponse.parse(parseJson(response)).cards as CardDraft[];
    return { cards, usage: usageOf(response, model), producedBy: this.name };
  }

  private buildRequest(args: BuildArgs): Anthropic.MessageCreateParamsNonStreaming {
    return buildMessageParams({ ...args, maxTokens: this.maxTokens });
  }
}

export type BuildArgs = {
  model: string;
  slot: Slot;
  schema: Record<string, unknown>;
  spice: 1 | 2 | 3;
  userText: string;
};

  /**
   * Assemblaggio della richiesta. Tre scelte non negoziabili:
   * 1. il prefisso congelato porta il breakpoint di cache con TTL 1h;
   * 2. i dati della lega stanno DOPO il breakpoint, mai dentro il system;
   * 3. le istruzioni operatore viaggiano sul canale system, che non è
   *    falsificabile da un nome squadra scelto dall'utente.
   */
export function buildMessageParams(
  args: BuildArgs & { maxTokens: number },
): Anthropic.MessageCreateParamsNonStreaming {
    const { model, slot, schema, spice, userText } = args;
    const directive = spiceDirective(spice);

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: userText }] },
    ];
    if (SUPPORTS_MIDCONV_SYSTEM.has(model)) {
      // Canale operatore non falsificabile, e non invalida il prefisso cachato.
      (messages as unknown[]).push({ role: 'system', content: directive });
    } else {
      const first = messages[0];
      if (first && Array.isArray(first.content)) {
        first.content.push({ type: 'text', text: `\n<direttiva_operatore>\n${directive}\n</direttiva_operatore>` });
      }
    }

    const outputConfig: Record<string, unknown> = {
      format: { type: 'json_schema', schema },
    };
    const effort = EFFORT[slot];
    if (effort && SUPPORTS_EFFORT.has(model)) outputConfig.effort = effort;

    const params: Record<string, unknown> = {
      model,
      max_tokens: args.maxTokens,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // TTL 1h: il batch non dà controllo sui tempi di esecuzione, e con
          // centinaia di letture sullo stesso prefisso il write si ammortizza
          // subito. Con 5m si pagherebbero cold miss a raffica.
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages,
      output_config: outputConfig,
    };
    if (SUPPORTS_ADAPTIVE_THINKING.has(model)) params.thinking = { type: 'adaptive' };

    return params as unknown as Anthropic.MessageCreateParamsNonStreaming;
}

function parseJson(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'refusal') {
    throw new Error('Il modello ha rifiutato la richiesta (stop_reason: refusal).');
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new Error('Risposta vuota dal modello.');
  return JSON.parse(text);
}

function usageOf(response: Anthropic.Message, model: string): Usage {
  const u = response.usage;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    model,
  };
}

/** I dati della lega, delimitati ed etichettati come dati. */
export function buildArticlePrompt(req: ArticleRequest): string {
  return [
    '<contesto>',
    `lega: ${req.leagueName}`,
    `giornata: ${req.matchday}`,
    '</contesto>',
    '',
    '<fatti_verificati>',
    'Questi sono gli UNICI numeri che puoi usare.',
    ...req.facts.map((f, i) => formatFact(f, i + 1)),
    '</fatti_verificati>',
    '',
    '<compito>',
    `formato: ${req.formatLabel}`,
    `istruzioni di formato: ${req.formatBrief}`,
    `voce: ${req.personaName} — ${req.personaVoice}`,
    `posizione nel giornale: ${req.slot}`,
    '</compito>',
    ...(req.correction
      ? ['', '<correzione>', req.correction, '</correzione>']
      : []),
  ].join('\n');
}

function formatFact(fact: NarrativeFact, index: number): string {
  const numbers = Object.entries(fact.numbers).map(([k, v]) => `${k}=${v}`).join(' ');
  const subjects = fact.subjects.map((s) => `${s.kind}:${s.display}`).join(', ');
  return [
    `[${index}] id=${fact.id}`,
    `    tipo: ${fact.type} (${fact.polarity})`,
    `    soggetti: ${subjects}`,
    `    numeri: ${numbers}`,
    `    sintesi: ${fact.plain}`,
  ].join('\n');
}

export function buildCardsPrompt(req: CardRequest): string {
  return [
    '<contesto>',
    `lega: ${req.leagueName}`,
    `giornata: ${req.matchday}`,
    '</contesto>',
    '',
    '<compito>',
    'Scrivi una card personale per ciascun presidente. Ogni card parla SOLO del suo destinatario.',
    'Restituisci teamId identico a quello ricevuto.',
    '</compito>',
    '',
    '<card_richieste>',
    ...req.cards.map((c) => [
      `teamId: ${c.teamId}`,
      `  squadra: ${c.teamName}`,
      `  tono: ${c.tone}`,
      `  numeri: ${Object.entries(c.fact.numbers).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      `  sintesi: ${c.fact.plain}`,
    ].join('\n')),
    '</card_richieste>',
  ].join('\n');
}
