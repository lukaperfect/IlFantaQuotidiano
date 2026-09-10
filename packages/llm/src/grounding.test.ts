import { describe, it, expect } from 'vitest';
import type { NarrativeFact } from '@fantacomics/core';
import { normalizeNumber, extractNumbers, allowedNumbersFor, checkGrounding, textOfBlocks } from './grounding.js';

const fact = (numbers: Record<string, string>, plain: string): NarrativeFact => ({
  id: 'f1', type: 'BEFFA_DECIMALE', matchday: 12, drama: 80, polarity: 'tragedia',
  rarityPercentile: null, subjects: [{ kind: 'team', id: 't1', display: 'T1' }],
  numbers, plain, evidence: [],
});

describe('normalizzazione dei numeri', () => {
  it('porta virgola, zeri e segni a forma canonica', () => {
    expect(normalizeNumber('71,5')).toBe('71.5');
    expect(normalizeNumber('72.0')).toBe('72');
    expect(normalizeNumber('+3.5')).toBe('3.5');
    expect(normalizeNumber('-0,5')).toBe('0.5');
    expect(normalizeNumber('007')).toBe('7');
  });
});

describe('estrazione', () => {
  it('trova i numeri con unità e ordinali', () => {
    const hits = extractNumbers('Ha chiuso a 71,5 punti, 3° posto, +2 gol e 100%.');
    expect(hits.map((h) => h.normalized)).toEqual(['71.5', '3', '2', '100']);
  });

  it('ignora i numeri dentro le parole', () => {
    expect(extractNumbers('formazione 4-3-3').map((h) => h.normalized)).toEqual(['4', '3', '3']);
  });
});

describe('insieme dei numeri autorizzati', () => {
  it('include valori, scomposizioni e numeri della frase secca', () => {
    const allowed = allowedNumbersFor([
      fact({ punti: '71.5', scarto: '0.5', risultato: '1-2' }, 'Ha perso per 0.5 punti: 71.5 contro 72.'),
    ]);
    expect(allowed.has('71.5')).toBe(true);
    expect(allowed.has('0.5')).toBe(true);
    expect(allowed.has('1')).toBe(true);   // scomposto da "1-2"
    expect(allowed.has('2')).toBe(true);
    expect(allowed.has('72')).toBe(true);  // presente solo nella frase secca
    expect(allowed.has('12')).toBe(true);  // la giornata
  });
});

describe('verifica del grounding', () => {
  const allowed = allowedNumbersFor([
    fact({ punti: '71.5', mancanti: '0.5' }, 'Si è fermato a 71.5, a 0.5 dalla soglia.'),
  ]);

  it('accetta un testo che usa solo i numeri forniti', () => {
    const r = checkGrounding('Si ferma a 71,5 punti. Mancavano 0,5.', allowed);
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('blocca una statistica inventata', () => {
    const r = checkGrounding('Ha chiuso a 83,5 punti, il suo record.', allowed);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.severity).toBe('high');
    expect(r.violations[0]?.raw).toBe('83,5');
  });

  it('blocca un intero grande anche senza decimali', () => {
    expect(checkGrounding('Erano 47 le occasioni.', allowed).ok).toBe(false);
  });

  it('blocca un intero piccolo se è seguito da un unità statistica', () => {
    const r = checkGrounding('Gli mancavano 3 punti.', allowed);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.severity).toBe('high');
  });

  it('segnala ma non blocca un intero piccolo usato come conteggio in prosa', () => {
    const r = checkGrounding('I 3 difensori sono rimasti a guardare.', allowed);
    expect(r.ok).toBe(true);
    expect(r.violations[0]?.severity).toBe('low');
  });

  it('riporta il contesto della violazione, per la correzione', () => {
    const r = checkGrounding('Il tabellino diceva 99,5 e nessuno ci credeva.', allowed);
    expect(r.violations[0]?.context).toContain('99,5');
  });
});

describe('estrazione del testo dai blocchi IR', () => {
  it('raccoglie la prosa e ignora i metadati', () => {
    const text = textOfBlocks([
      { kind: 'headline', text: 'Titolo da 71.5' },
      { kind: 'body', paragraphs: ['Primo paragrafo.', 'Secondo con 0.5.'] },
      { kind: 'boxscore', factId: 'beffa-1234', caption: 'Il tabellino' },
    ]);
    expect(text).toContain('Titolo da 71.5');
    expect(text).toContain('Secondo con 0.5.');
    expect(text).toContain('Il tabellino');
    // `kind` e `factId` non sono prosa: verificarli produrrebbe falsi positivi.
    expect(text).not.toContain('beffa-1234');
    expect(text).not.toContain('headline');
  });
});
