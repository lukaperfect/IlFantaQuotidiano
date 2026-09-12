import type { Edition } from '@fantacomics/core';
import { esc } from './html.js';

export type CardFormat = 'feed' | 'story' | 'og';

const SIZES: Record<CardFormat, { w: number; h: number }> = {
  feed: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
  og: { w: 1200, h: 630 },
};

const TONE_COLOR: Record<string, string> = {
  gloria: '#8a1c1c',
  disfatta: '#4a443a',
  grigiore: '#8d8676',
};

/**
 * Word wrap approssimato.
 * SVG non manda a capo da solo: il testo va spezzato in tspan a mano. La
 * larghezza si stima dalla dimensione del font — è sufficiente perché i
 * limiti di lunghezza dell'IR tengono già i testi dentro intervalli noti.
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, factor = 0.52): string[] {
  const charsPerLine = Math.max(8, Math.floor(maxWidth / (fontSize * factor)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= charsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export type CardInput = {
  teamName: string;
  headline: string;
  body: string;
  statLabel: string;
  statValue: string;
  tone: string;
  matchday: number;
  leagueName: string;
};

/**
 * La card personale come SVG.
 *
 * È la feature che moltiplica la condivisione: si passa da una condivisione
 * per lega a una per presidente. Per questo ogni card parla SOLO del suo
 * destinatario.
 */
export function renderCardSvg(card: CardInput, format: CardFormat = 'feed'): string {
  const { w, h } = SIZES[format];
  const pad = Math.round(w * 0.075);
  const inner = w - pad * 2;
  const accent = TONE_COLOR[card.tone] ?? TONE_COLOR.grigiore as string;
  const compact = format === 'og';

  const headlineSize = compact ? 54 : 72;
  const bodySize = compact ? 26 : 36;

  const headlineLines = wrapText(card.headline, inner, headlineSize, 0.55).slice(0, 3);
  const bodyLines = wrapText(card.body, inner, bodySize, 0.52).slice(0, compact ? 3 : 6);

  const parts: string[] = [];
  let y = pad + (compact ? 42 : 74);

  parts.push(`<rect width="${w}" height="${h}" fill="#f4f1e8"/>`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${compact ? 10 : 16}" fill="${accent}"/>`);

  parts.push(text(pad, y, `FANTACOMICS · GIORNATA ${card.matchday}`, {
    size: compact ? 18 : 24, family: 'grotesque', fill: '#4a443a', spacing: 4, weight: '700',
  }));
  y += compact ? 34 : 46;

  parts.push(text(pad, y, card.teamName.toUpperCase(), {
    size: compact ? 24 : 32, family: 'grotesque', fill: accent, spacing: 3, weight: '700',
  }));

  const headerBottom = y + (compact ? 46 : 74);
  const statBaseline = h - pad - (compact ? 30 : 62);
  const statRuleY = statBaseline - (compact ? 62 : 104);

  /**
   * Il blocco di testo si centra verticalmente nello spazio disponibile.
   * Ancorarlo in alto lascia un buco enorme al centro quando il testo e'
   * corto — ed e' il caso normale, non l'eccezione: i limiti dell'IR tengono
   * i corpi sotto i 320 caratteri.
   */
  const headlineLh = Math.round(headlineSize * 1.12);
  const bodyLh = Math.round(bodySize * 1.36);
  const gap = compact ? 14 : 28;
  const contentH = headlineLines.length * headlineLh + gap + bodyLines.length * bodyLh;
  y = headerBottom + Math.max(0, Math.round((statRuleY - headerBottom - contentH) / 2));

  for (const line of headlineLines) {
    parts.push(text(pad, y, line, { size: headlineSize, family: 'serif', fill: '#16130f', weight: '800' }));
    y += headlineLh;
  }

  y += gap;
  for (const line of bodyLines) {
    parts.push(text(pad, y, line, { size: bodySize, family: 'serif', fill: '#332e26' }));
    y += bodyLh;
  }

  // La statistica in evidenza è ancorata in basso: è il punto che si guarda per primo.
  const statY = statBaseline;
  parts.push(`<line x1="${pad}" y1="${statRuleY}" x2="${w - pad}" y2="${statRuleY}" stroke="#16130f" stroke-width="2"/>`);
  parts.push(text(pad, statY, card.statValue, {
    size: compact ? 76 : 122, family: 'grotesque', fill: accent, weight: '800',
  }));
  parts.push(text(pad + measure(card.statValue, compact ? 76 : 122) + 20, statY, card.statLabel.toUpperCase(), {
    size: compact ? 20 : 28, family: 'grotesque', fill: '#4a443a', spacing: 3, weight: '700',
  }));

  parts.push(text(w - pad, h - pad + (compact ? 6 : 10), card.leagueName, {
    size: compact ? 18 : 24, family: 'serif', fill: '#8d8676', anchor: 'end', italic: true,
  }));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(card.headline)}">`,
    ...parts,
    '</svg>',
  ].join('\n');
}

const FAMILIES = {
  serif: '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif',
  grotesque: '"Helvetica Neue",Helvetica,Arial,sans-serif',
};

function text(
  x: number, y: number, content: string,
  o: { size: number; family: keyof typeof FAMILIES; fill: string; weight?: string; spacing?: number; anchor?: string; italic?: boolean },
): string {
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    `font-family='${FAMILIES[o.family]}'`,
    `font-size="${o.size}"`,
    `fill="${o.fill}"`,
    o.weight ? `font-weight="${o.weight}"` : '',
    o.spacing ? `letter-spacing="${o.spacing}"` : '',
    o.anchor ? `text-anchor="${o.anchor}"` : '',
    o.italic ? 'font-style="italic"' : '',
  ].filter(Boolean).join(' ');
  return `<text ${attrs}>${esc(content)}</text>`;
}

function measure(s: string, size: number): number {
  return Math.round(s.length * size * 0.58);
}

/** Estrae le card dall'edizione nella forma richiesta dal renderer. */
export function cardsOf(edition: Edition): CardInput[] {
  return edition.personalCards.map((c) => ({
    teamName: c.teamName,
    headline: c.headline,
    body: c.body,
    statLabel: c.stat.label,
    statValue: c.stat.value,
    tone: c.tone,
    matchday: edition.meta.matchday,
    leagueName: edition.meta.leagueName,
  }));
}
