import { describe, it, expect } from 'vitest';
import {
  normalizeForComparison, shingles, containment, checkRepetition, buildPastCorpus,
  SOGLIA_RIPETIZIONE,
} from './similarity.js';

describe('normalizzazione', () => {
  it('azzera differenze che non contano', () => {
    expect(normalizeForComparison('Perso per 0,5 punti!  È così.'))
      .toBe('perso per 0 5 punti e cosi');
  });
});

describe('shingle', () => {
  it('produce n-grammi scorrevoli di parole', () => {
    const s = shingles('uno due tre quattro cinque sei', 5);
    expect([...s]).toEqual(['uno due tre quattro cinque', 'due tre quattro cinque sei']);
  });

  it('un testo più corto di n resta un solo shingle', () => {
    expect([...shingles('uno due', 5)]).toEqual(['uno due']);
    expect(shingles('', 5).size).toBe(0);
  });
});

describe('contenimento', () => {
  it('è 1 quando il nuovo è interamente contenuto nel passato', () => {
    const passato = shingles('il gatto sale sul tetto rosso della casa', 5);
    const nuovo = shingles('il gatto sale sul tetto rosso', 5);
    expect(containment(nuovo, passato)).toBe(1);
  });

  it('è 0 su testi senza nulla in comune', () => {
    expect(containment(shingles('alfa beta gamma delta epsilon'), shingles('uno due tre quattro cinque')))
      .toBe(0);
  });

  it('non è simmetrico, ed è il motivo per cui si usa al posto di Jaccard', () => {
    // Un pezzo corto che ricopia una frase da un'edizione lunga: Jaccard
    // sarebbe basso, il contenimento e' 1 — ed e' il caso da cogliere.
    // Il riempitivo dev'essere VARIO: parole ripetute collassano in un solo
    // shingle e il testo "lungo" finirebbe per averne quanti il corto.
    const riempitivo = Array.from({ length: 80 }, (_, i) => `parola${i}`).join(' ');
    const lungo = shingles(`${riempitivo} una frase presa di peso dal giornale`, 5);
    const corto = shingles('una frase presa di peso dal giornale', 5);

    expect(lungo.size).toBeGreaterThan(60);
    expect(containment(corto, lungo)).toBe(1);
    expect(containment(lungo, corto)).toBeLessThan(0.1);
  });
});

describe('guardia anti-ripetizione', () => {
  const passato = buildPastCorpus([
    'Real Sporcaccioni ha fatto settantuno punti e mezzo e non ha vinto la partita di giornata',
    'Il giallo di Wagner è costato mezzo punto esattamente quanto mancava per il gol',
  ]);

  it('non segnala un pezzo scritto da capo', () => {
    const r = checkRepetition(
      'Dinamo Divano si ferma sulla soglia, con la panchina che guardava e il modulo sbagliato in mano.',
      passato,
    );
    expect(r.ripetuto).toBe(false);
    expect(r.containment).toBeLessThan(SOGLIA_RIPETIZIONE);
  });

  it('segnala un pezzo che ricalca il passato e cita le frasi', () => {
    const r = checkRepetition(
      'Il giallo di Wagner è costato mezzo punto esattamente quanto mancava per il gol',
      passato,
    );
    expect(r.ripetuto).toBe(true);
    expect(r.containment).toBe(1);
    expect(r.frasiRipetute.length).toBeGreaterThan(0);
    expect(r.frasiRipetute[0]).toContain('wagner');
  });

  it('tollera una citazione breve dentro un pezzo per il resto nuovo', () => {
    const r = checkRepetition(
      'Il giallo di Wagner è costato mezzo punto. ' +
      'Ma la vera notizia sta altrove: nello spogliatoio si parla di un modulo mai provato, ' +
      'di una panchina che nessuno guarda e di un presidente che ha smesso di rispondere al telefono. ' +
      'La squadra intanto continua a perdere pezzi in ogni reparto e la classifica non perdona nessuno.',
      passato,
    );
    expect(r.ripetuto).toBe(false);
  });

  it('non segnala nulla contro un corpus vuoto', () => {
    expect(checkRepetition('Qualunque cosa scritta qui dentro', new Set()).ripetuto).toBe(false);
  });

  it('la soglia è configurabile', () => {
    const testo = 'Il giallo di Wagner è costato mezzo punto esattamente quanto mancava per il gol';
    expect(checkRepetition(testo, passato, 0.99).ripetuto).toBe(true);
    expect(checkRepetition(testo, passato, 1).ripetuto).toBe(false);
  });
});
