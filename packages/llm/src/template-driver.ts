import type { Block, NarrativeFact } from '@fantacomics/core';
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
    const facts = [...req.facts];
    const anchor = facts[0];
    const rest = facts.slice(1);
    const blocks: Block[] = [];

    blocks.push({ kind: 'headline', text: headlineFor(anchor, req.formatLabel) });

    /**
     * Occhiello e corpo non devono MAI ripetere la stessa frase: e' il difetto
     * che rende evidente a colpo d'occhio che il pezzo e' stato composto da una
     * macchina. L'occhiello prende il fatto d'apertura, il corpo prende gli
     * altri; con un fatto solo l'occhiello sparisce invece di duplicare.
     * Per lo stesso motivo qui non si emettono citazioni in evidenza: in
     * modalita' degradata potrebbero solo ripetere una frase gia' stampata.
     */
    if (rest.length > 0 && anchor) {
      blocks.push({ kind: 'standfirst', text: clamp(anchor.plain, 20, 180) });
    }

    const material = rest.length > 0 ? rest : anchor ? [anchor] : [];
    const allowed = new Set(req.allowedBlockKinds ?? []);
    // La lista si usa solo dove il formato la prevede: un'apertura di prima
    // pagina con gli elenchi puntati non e' un'apertura di prima pagina.
    const wantsList = allowed.has('list') && req.slot !== 'apertura';

    if (wantsList && material.length >= 2) {
      blocks.push({
        kind: 'list',
        title: clamp(req.formatLabel, 0, 60),
        items: material.slice(0, 8).map((f) => clamp(f.plain, 3, 220)),
      });
    } else {
      const paragraphs: string[] = [];
      for (const f of material) {
        const last = paragraphs[paragraphs.length - 1];
        // I paragrafi hanno un minimo di lunghezza nell'IR: si accorpano
        // invece di riempirli di parole vuote.
        if (last !== undefined && last.length < 120) paragraphs[paragraphs.length - 1] = `${last} ${f.plain}`;
        else paragraphs.push(f.plain);
      }
      const merged = paragraphs.map((p) => clamp(p, 40, 700)).filter((p) => p.length >= 40);
      blocks.push({
        kind: 'body',
        paragraphs: merged.length > 0 ? merged : [clamp(anchor?.plain ?? 'Giornata senza storia.', 40, 700)],
      });
    }

    return { blocks, usage: null, producedBy: this.name };
  }

  async personalCards(req: CardRequest): Promise<CardsDraft> {
    const cards: CardDraft[] = req.cards.map((c) => {
      const [label, value] = primaryNumber(c.fact);
      return {
        teamId: c.teamId,
        // Il nome squadra e' gia' nel soprattitolo della card: ripeterlo
        // nel titolo spreca la riga piu' preziosa.
        headline: clamp(toneWord(c.tone), 5, 70),
        body: clamp(c.fact.plain, 20, 320),
        statLabel: clamp(humanizeKey(label), 0, 40),
        statValue: clamp(value, 0, 16),
      };
    });
    return { cards, usage: null, producedBy: this.name };
  }
}

/** "rimpiantoPanchina" -> "Rimpianto panchina": le chiavi non sono etichette. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function toneWord(tone: string): string {
  if (tone === 'gloria') return 'La giornata giusta';
  if (tone === 'grigiore') return 'Ordinaria amministrazione';
  return 'Si poteva evitare';
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
