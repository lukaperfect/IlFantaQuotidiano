import { z } from 'zod';

/**
 * Document IR — il contratto tra LLM e rendering.
 * L'LLM produce QUESTO, mai HTML. Un solo contenuto alimenta web, PDF e card social.
 * I vincoli di lunghezza non sono cosmetici: sono la differenza tra
 * un layout tipografico e un layout rotto.
 */

export const HeadlineBlockSchema = z.object({
  kind: z.literal('headline'),
  text: z.string().min(8).max(62),
});

export const StandfirstBlockSchema = z.object({
  kind: z.literal('standfirst'),
  text: z.string().min(20).max(180),
});

export const BodyBlockSchema = z.object({
  kind: z.literal('body'),
  paragraphs: z.array(z.string().min(40).max(700)).min(1).max(8),
});

export const PullQuoteBlockSchema = z.object({
  kind: z.literal('pull_quote'),
  text: z.string().min(10).max(160),
  attribution: z.string().max(60).default(''),
});

export const InterviewBlockSchema = z.object({
  kind: z.literal('interview'),
  intro: z.string().max(300).default(''),
  qa: z.array(z.object({
    q: z.string().min(5).max(220),
    a: z.string().min(5).max(500),
  })).min(2).max(8),
});

export const PagellaBlockSchema = z.object({
  kind: z.literal('pagella'),
  rows: z.array(z.object({
    subject: z.string().min(1).max(40),
    vote: z.string().min(1).max(6),
    note: z.string().min(5).max(180),
  })).min(2).max(12),
});

/**
 * Il tabellino NON contiene numeri generati: referenzia un fatto per id.
 * I numeri li mette il renderer, leggendoli dal fact pack.
 */
export const BoxscoreBlockSchema = z.object({
  kind: z.literal('boxscore'),
  factId: z.string().min(1),
  caption: z.string().max(120).default(''),
});

export const ListBlockSchema = z.object({
  kind: z.literal('list'),
  title: z.string().max(60).default(''),
  items: z.array(z.string().min(3).max(220)).min(2).max(10),
});

export const BlockSchema = z.discriminatedUnion('kind', [
  HeadlineBlockSchema,
  StandfirstBlockSchema,
  BodyBlockSchema,
  PullQuoteBlockSchema,
  InterviewBlockSchema,
  PagellaBlockSchema,
  BoxscoreBlockSchema,
  ListBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

/** Gli slot di impaginazione. Il layout li conosce, l'LLM li riempie. */
export const SlotSchema = z.enum([
  'apertura',      // pezzo di prima pagina
  'spalla',        // colonna laterale di prima
  'taglio_basso',  // fondo pagina
  'interno',       // pagine interne
  'rubrica',       // formato ricorrente
  'serie_a',       // contenuto GLOBALE, condiviso tra tutte le leghe
]);
export type Slot = z.infer<typeof SlotSchema>;

export const ArticleSchema = z.object({
  slot: SlotSchema,
  /** Il format editoriale estratto dal deck (es. 'intervista_impossibile'). */
  format: z.string().min(1),
  /** La voce giornalistica usata (persona rotation). */
  persona: z.string().min(1),
  blocks: z.array(BlockSchema).min(1).max(12),
  /** I fatti da cui questo pezzo nasce: alimenta il grounding e la tracciabilità. */
  factIds: z.array(z.string()).default([]),
});
export type Article = z.infer<typeof ArticleSchema>;

export const EditionMetaSchema = z.object({
  leagueId: z.string().min(1),
  leagueName: z.string().min(1),
  season: z.string(),
  matchday: z.number().int().min(1).max(38),
  publishedAt: z.string().datetime({ offset: true }),
  /** Versioning completo: riproducibilità, A/B sui prompt, risposte alle contestazioni. */
  factEngineVersion: z.string(),
  promptVersion: z.string(),
  rulesetVersion: z.number().int(),
  models: z.record(z.string(), z.string()),
  selectorSeed: z.string(),
  /** 0-1. Sotto soglia => coda di revisione umana, non pubblicazione. */
  confidence: z.number().min(0).max(1),
  /** Se la riconciliazione è fallita, l'edizione gira in modalità ridotta. */
  degraded: z.boolean().default(false),
});
export type EditionMeta = z.infer<typeof EditionMetaSchema>;

export const EditionSchema = z.object({
  meta: EditionMetaSchema,
  masthead: z.object({
    title: z.string().default('FantaComics'),
    /** Il sommario di testata, sotto la testata. */
    tagline: z.string().max(120).default(''),
  }),
  articles: z.array(ArticleSchema).min(1),
  /** Una card personale per presidente: è ciò che moltiplica la condivisione. */
  personalCards: z.array(z.object({
    teamId: z.string().min(1),
    teamName: z.string().min(1),
    headline: z.string().min(5).max(70),
    body: z.string().min(20).max(320),
    stat: z.object({ label: z.string().max(40), value: z.string().max(16) }),
    tone: z.enum(['gloria', 'disfatta', 'grigiore']),
  })).default([]),
});
export type Edition = z.infer<typeof EditionSchema>;
