import type { Block, EditionKind, NarrativeFact, Slot } from '@fantacomics/core';

export type SpiceLevel = 1 | 2 | 3;

export type ArticleRequest = {
  slot: Slot;
  formatId: string;
  formatLabel: string;
  formatBrief: string;
  personaName: string;
  personaVoice: string;
  facts: readonly NarrativeFact[];
  leagueName: string;
  matchday: number;
  spice: SpiceLevel;
  /** Vigilia o retrospettivo. Predefinito `giornale` presso ogni consumatore. */
  kind?: EditionKind;
  /** Gli accoppiamenti in programma: solo nell'anteprima, dove non c'e' tabellino. */
  fixtures?: readonly { homeTeam: string; awayTeam: string }[];
  allowedBlockKinds?: readonly string[];
  /** Correzione per il secondo tentativo dopo una violazione di grounding. */
  correction?: string;
};

export type CardRequest = {
  leagueName: string;
  matchday: number;
  spice: SpiceLevel;
  kind?: EditionKind;
  cards: readonly { teamId: string; teamName: string; fact: NarrativeFact; tone: string }[];
};

export type CardDraft = {
  teamId: string;
  headline: string;
  body: string;
  statLabel: string;
  statValue: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
};

export type ArticleDraft = {
  blocks: Block[];
  usage: Usage | null;
  /** Quale driver l'ha prodotto: finisce nei metadati dell'edizione. */
  producedBy: string;
};

export type CardsDraft = {
  cards: CardDraft[];
  usage: Usage | null;
  producedBy: string;
};

/**
 * L'astrazione che rende il giornale INDIPENDENTE dalla disponibilità del modello.
 * Se l'LLM non risponde, la pipeline ripiega sul driver template e il giornale
 * esce comunque — più secco, ma esce. Un prodotto settimanale che salta una
 * settimana perde gli abbonati; uno più sobrio no.
 */
export interface LlmDriver {
  readonly name: string;
  article(req: ArticleRequest): Promise<ArticleDraft>;
  personalCards(req: CardRequest): Promise<CardsDraft>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'none',
};
