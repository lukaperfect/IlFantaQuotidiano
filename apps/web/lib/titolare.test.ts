import { describe, it, expect } from 'vitest';
import { titolare, fornitoreModello } from './titolare.js';

const pieno = {
  FANTACOMICS_TITOLARE: 'Mario Rossi',
  FANTACOMICS_PIVA: '01234567890',
  FANTACOMICS_INDIRIZZO: 'Via Roma 1, Milano',
  FANTACOMICS_EMAIL_CONTATTO: 'info@esempio.it',
};

describe('i dati del titolare', () => {
  it('con tutto compilato li restituisce', () => {
    expect(titolare(pieno)?.nome).toBe('Mario Rossi');
  });

  it('e\' tutto o niente', () => {
    // Dei termini con META' dei dati del titolare sono peggio di dei termini
    // dichiaratamente incompleti, perche' non si vede che mancano.
    for (const manca of Object.keys(pieno)) {
      expect(titolare({ ...pieno, [manca]: undefined }), manca).toBeNull();
    }
  });

  it('una variabile vuota o di soli spazi vale come assente', () => {
    // Nei file di deploy capita di dichiarare una variabile senza valorizzarla:
    // leggerla come «compilata» farebbe sparire l'avviso lasciando la pagina
    // con un buco al posto del titolare.
    expect(titolare({ ...pieno, FANTACOMICS_PIVA: '' })).toBeNull();
    expect(titolare({ ...pieno, FANTACOMICS_PIVA: '   ' })).toBeNull();
  });

  it('il fornitore del modello si nomina solo se lo si sta davvero usando', () => {
    // Dichiarare un trasferimento che non avviene e' sbagliato quanto tacerne
    // uno che avviene.
    expect(fornitoreModello({ ANTHROPIC_API_KEY: 'sk-x' })).toContain('Anthropic');
    expect(fornitoreModello({})).toContain('localmente');
  });
});
