import type { Block, NarrativeFact } from '@fantacomics/core';
import { seededRandom } from '@fantacomics/core';
import type { ArticleDraft, ArticleRequest, CardDraft, CardRequest, CardsDraft, LlmDriver } from './driver.js';

/**
 * Driver di ripiego, deterministico e senza rete.
 *
 * Non e' un mock da test: e' la MODALITA' DEGRADATA di produzione. Compone il
 * giornale dai `plain` dei fatti, che sono gia' frasi complete e gia' corrette
 * nei numeri. Il risultato e' asciutto ma pubblicabile, e per costruzione non
 * puo' violare il grounding numerico.
 */
export class TemplateDriver implements LlmDriver {
  readonly name = 'template';

  async article(req: ArticleRequest): Promise<ArticleDraft> {
    const rnd = seededRandom(`${req.formatId}:${req.matchday}:${req.facts[0]?.id ?? ''}`);
    const facts = [...req.facts];
    const anchor = facts[0];
    const blocks: Block[] = [];

    blocks.push({ kind: 'headline', text: headlineFor(anchor, req.formatLabel) });

    const standfirst = `${req.formatLabel} · ${req.personaName}. ${anchor?.plain ?? ''}`;
    blocks.push({ kind: 'standfirst', text: clamp(standfirst, 20, 180) });

    const allowed = new Set(req.allowedBlockKinds ?? []);
    const wantsList = allowed.size > 0 ? allowed.has('list') : facts.length >= 3;

    if (wantsList) {
      blocks.push({
        kind: 'list',
        title: clamp(req.formatLabel, 0, 60),
        items: facts.slice(0, 8).map((f) => clamp(f.plain, 3, 220)),
      });
    } else {
      const paragraphs: string[] = [];
      for (const f of facts) {
        const last = paragraphs[paragraphs.length - 1];
        // I paragrafi hanno un minimo di lunghezza nell'IR: si accorpano
        // invece di riempirli di parole vuote.
        if (last !== undefined && last.length < 120) paragraphs[paragraphs.length - 1] = `${last} ${f.plain}`;
        else paragraphs.push(f.plain);
      }
      const merged = paragraphs.map((p) => clamp(p, 40, 700)).filter((p) => p.length >= 40);
      blocks.push({ kind: 'body', paragraphs: merged.length > 0 ? merged : [clamp(anchor?.plain ?? 'Giornata senza storia.', 40, 700)] });
    }

    if (facts.length > 1 && rnd() > 0.4) {
      const quote = facts[1];
      if (quote) {
        blocks.push({
          kind: 'pull_quote',
          text: clamp(quote.plain, 10, 160),
          attribution: clamp(quote.subjects[0]?.display ?? '', 0, 60),
        });
      }
    }

    return { blocks, usage: null, producedBy: this.name };
  }

  async personalCards(req: CardRequest): Promise<CardsDraft> {
    const cards: CardDraft[] = req.cards.map((c) => {
      const [label, value] = primaryNumber(c.fact);
      return {
        teamId: c.teamId,
        headline: clamp(`${c.teamName}: ${toneWord(c.tone)}`, 5, 70),
        body: clamp(c.fact.plain, 20, 320),
        statLabel: clamp(label, 0, 40),
        statValue: clamp(value, 0, 16),
      };
    });
    return { cards, usage: null, producedBy: this.name };
  }
}

function toneWord(tone: string): string {
  if (tone === 'gloria') return 'la giornata giusta';
  if (tone === 'grigiore') return 'ordinaria amministrazione';
  return 'si poteva evitare';
}

function headlineFor(fact: NarrativeFact | undefined, fallback: string): string {
  if (!fact) return clamp(fallback, 8, 62);
  const subject = fact.subjects[0]?.display ?? fallback;
  const [, value] = primaryNumber(fact);
  const candidate = value ? `${subject}, ${value}` : subject;
  return clamp(candidate, 8, 62);
}

/** Il numero piu' rappresentativo del fatto, per la stat in evidenza. */
function primaryNumber(fact: NarrativeFact): [string, string] {
  const priority = ['punti', 'mancanti', 'scarto', 'rimpianto', 'rimpiantoPanchina', 'battuti', 'fantavoto'];
  for (const key of priority) {
    const v = fact.numbers[key];
    if (v !== undefined) return [key, v];
  }
  const first = Object.entries(fact.numbers)[0];
  return first ? [first[0], first[1]] : ['', ''];
}

function clamp(text: string, min: number, max: number): string {
  let s = text.trim().replace(/\s+/g, ' ');
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  if (min > 0 && s.length < min) s = s.padEnd(min, '.');
  return s;
}
