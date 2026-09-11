import { describe, it, expect } from 'vitest';
import {
  oraLocale, istanteLocale, finestraVigilia, finestraRetrospettivo, decidiUscita,
  USCITE_PREDEFINITE, type CalendarioGiornata,
} from './calendario.js';

const ROMA = 'Europe/Rome';

/** Una giornata dagli orari dati, in ISO con offset. */
function giornata(...kickoff: string[]): CalendarioGiornata {
  return { matchday: 12, partite: kickoff.map((k) => ({ kickoff: k })) };
}

describe('l\'orologio da parete', () => {
  it('legge l\'ora italiana d\'inverno e d\'estate', () => {
    // Gennaio: Roma e' UTC+1.
    expect(oraLocale(new Date('2026-01-15T12:00:00Z'), ROMA))
      .toEqual({ anno: 2026, mese: 1, giorno: 15, ora: 13, minuto: 0 });
    // Luglio: UTC+2.
    expect(oraLocale(new Date('2026-07-15T12:00:00Z'), ROMA))
      .toEqual({ anno: 2026, mese: 7, giorno: 15, ora: 14, minuto: 0 });
  });

  it('una partita di lunedi\' sera resta di lunedi\', non diventa di martedi\'', () => {
    /**
     * 20:45 a Roma d'inverno sono le 19:45 UTC: chi leggesse i campi UTC
     * vedrebbe ancora lunedi', ma d'estate le 20:45 sono le 18:45 UTC e un
     * posticipo delle 22:30 finirebbe oltre la mezzanotte UTC — cioe' il giorno
     * dopo. E' il modo in cui la data del giornale scivola di un giorno.
     */
    expect(oraLocale(new Date('2026-08-17T22:30:00+02:00'), ROMA).giorno).toBe(17);
    expect(new Date('2026-08-17T22:30:00+02:00').getUTCDate()).toBe(17);
    expect(oraLocale(new Date('2026-08-17T23:30:00+02:00'), ROMA).giorno).toBe(17);
    // La prova che il caso e' reale: in UTC quella stessa partita e' del 17
    // alle 21:30, ma un'ora dopo sarebbe gia' il 18.
    expect(new Date('2026-08-18T00:30:00+02:00').getUTCDate()).toBe(17);
    expect(oraLocale(new Date('2026-08-18T00:30:00+02:00'), ROMA).giorno).toBe(18);
  });
});

describe('l\'istante di un\'ora da parete', () => {
  it('le otto del mattino d\'inverno e d\'estate sono istanti diversi', () => {
    expect(istanteLocale({ anno: 2026, mese: 1, giorno: 15 }, 8, 0, ROMA).toISOString())
      .toBe('2026-01-15T07:00:00.000Z');
    expect(istanteLocale({ anno: 2026, mese: 7, giorno: 15 }, 8, 0, ROMA).toISOString())
      .toBe('2026-07-15T06:00:00.000Z');
  });

  it('tiene il giorno in cui si va avanti con l\'ora', () => {
    /**
     * L'ultima domenica di marzo 2026 e' il 29: alle 02:00 si passa alle 03:00.
     * Le otto di QUELLA mattina sono gia' ora legale, quindi le 06:00 UTC — e
     * non le 07:00 che darebbe uno scarto preso dal giorno prima.
     */
    expect(istanteLocale({ anno: 2026, mese: 3, giorno: 29 }, 8, 0, ROMA).toISOString())
      .toBe('2026-03-29T06:00:00.000Z');
    // Il giorno prima e' ancora ora solare.
    expect(istanteLocale({ anno: 2026, mese: 3, giorno: 28 }, 8, 0, ROMA).toISOString())
      .toBe('2026-03-28T07:00:00.000Z');
  });

  it('tiene il giorno in cui si torna indietro', () => {
    // Ultima domenica di ottobre 2026: il 25. Alle 03:00 si torna alle 02:00.
    expect(istanteLocale({ anno: 2026, mese: 10, giorno: 25 }, 8, 0, ROMA).toISOString())
      .toBe('2026-10-25T07:00:00.000Z');
    expect(istanteLocale({ anno: 2026, mese: 10, giorno: 24 }, 8, 0, ROMA).toISOString())
      .toBe('2026-10-24T06:00:00.000Z');
  });

  it('serve DAVVERO la seconda passata, vicino al cambio dell\'ora', () => {
    /**
     * La prima stima interpreta l'ora da parete come se fosse UTC, e nei
     * dintorni del salto cade dal lato sbagliato: lo scarto misurato li' non e'
     * quello che vale all'istante cercato. Misurato con una passata sola:
     *
     *   01:30 del 29 marzo  -> 2026-03-28T23:30Z, che a Roma e' 00:30. Sbaglia
     *                          di un'ora intera.
     *   01:30 del 25 ottobre -> 2026-10-25T00:30Z, che a Roma e' 02:30. Idem.
     *
     * Il giornale esce alle otto e non passerebbe mai di qui, ma l'ora di
     * uscita e' configurabile: una funzione esportata che sbaglia di un'ora due
     * volte l'anno e' una trappola per chi la usera'.
     */
    const primoAprile = istanteLocale({ anno: 2026, mese: 3, giorno: 29 }, 1, 30, ROMA);
    expect(oraLocale(primoAprile, ROMA)).toEqual({
      anno: 2026, mese: 3, giorno: 29, ora: 1, minuto: 30,
    });

    const ottobre = istanteLocale({ anno: 2026, mese: 10, giorno: 25 }, 1, 30, ROMA);
    expect(oraLocale(ottobre, ROMA)).toEqual({
      anno: 2026, mese: 10, giorno: 25, ora: 1, minuto: 30,
    });
  });

  it('l\'ora che non esiste restituisce l\'istante subito dopo il salto', () => {
    /**
     * Le 02:30 del 29 marzo non esistono: alle 02:00 si passa alle 03:00. Non
     * e' un errore da segnalare — nessun chiamante di questo progetto ci
     * finisce — ma il comportamento va fissato, altrimenti «e' indefinito»
     * diventa «cambia quando cambio due righe».
     */
    const inesistente = istanteLocale({ anno: 2026, mese: 3, giorno: 29 }, 2, 30, ROMA);
    expect(oraLocale(inesistente, ROMA).ora).toBe(3);
    expect(inesistente.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('e\' l\'inverso esatto della lettura', () => {
    // Andata e ritorno su tutto l'anno, a cavallo dei due cambi.
    for (const mese of [1, 3, 4, 6, 8, 10, 11, 12]) {
      for (const giorno of [1, 15, 25, 28]) {
        const d = { anno: 2026, mese, giorno };
        const i = istanteLocale(d, 8, 0, ROMA);
        expect(oraLocale(i, ROMA), `${mese}/${giorno}`).toEqual({ ...d, ora: 8, minuto: 0 });
      }
    }
  });
});

describe('la finestra della vigilia', () => {
  it('apre la mattina del giorno della PRIMA partita, non della giornata', () => {
    // Una giornata da venerdi' a lunedi': la vigilia e' venerdi' mattina.
    const g = giornata(
      '2026-09-18T20:45:00+02:00', // venerdi'
      '2026-09-20T15:00:00+02:00', // domenica
      '2026-09-21T20:45:00+02:00', // lunedi'
    );
    const f = finestraVigilia(g)!;
    expect(f.apre.toISOString()).toBe('2026-09-18T06:00:00.000Z'); // 08:00 a Roma
    expect(f.chiude?.toISOString()).toBe('2026-09-18T18:45:00.000Z');
  });

  it('chiude al primo fischio: un\'anteprima a partite in corso e\' una contraddizione', () => {
    const g = giornata('2026-09-18T20:45:00+02:00', '2026-09-20T15:00:00+02:00');
    const f = finestraVigilia(g)!;
    const unMinutoDopo = new Date(f.chiude!.getTime() + 60000);
    expect(decidiUscita(g, unMinutoDopo).uscita).not.toBe('vigilia');
  });

  it('senza orari non c\'e\' finestra', () => {
    expect(finestraVigilia({ matchday: 1, partite: [] })).toBeNull();
    // Un orario illeggibile si scarta invece di diventare una data del 1970.
    expect(finestraVigilia({ matchday: 1, partite: [{ kickoff: 'boh' }] })).toBeNull();
  });

  it('ignora gli orari illeggibili ma tiene quelli buoni', () => {
    const f = finestraVigilia({
      matchday: 1,
      partite: [{ kickoff: 'non-una-data' }, { kickoff: '2026-09-18T20:45:00+02:00' }],
    })!;
    expect(f.chiude?.toISOString()).toBe('2026-09-18T18:45:00.000Z');
  });
});

describe('la finestra del retrospettivo', () => {
  it('apre la mattina DOPO l\'ultima partita', () => {
    const g = giornata('2026-09-18T20:45:00+02:00', '2026-09-21T20:45:00+02:00');
    const f = finestraRetrospettivo(g)!;
    // Ultima partita lunedi' 21 sera -> martedi' 22 alle 08:00 (06:00 UTC).
    expect(f.apre.toISOString()).toBe('2026-09-22T06:00:00.000Z');
    // Nessun limite: una giornata pronta in ritardo si consegna comunque.
    expect(f.chiude).toBeNull();
  });

  it('un posticipo notturno non sposta il giornale di due giorni', () => {
    /**
     * Una partita che finisce dopo la mezzanotte UTC ma prima della mezzanotte
     * ITALIANA e' ancora del giorno prima. Contando in UTC, il giornale
     * sarebbe uscito con un giorno di ritardo.
     */
    const g = giornata('2026-07-20T23:30:00+02:00'); // lunedi' sera, 21:30 UTC
    expect(finestraRetrospettivo(g)!.apre.toISOString()).toBe('2026-07-21T06:00:00.000Z');
  });

  it('un turno infrasettimanale in un giorno solo funziona come gli altri', () => {
    const g = giornata('2026-10-28T18:30:00+01:00', '2026-10-28T20:45:00+01:00');
    expect(finestraVigilia(g)!.apre.toISOString()).toBe('2026-10-28T07:00:00.000Z');
    expect(finestraRetrospettivo(g)!.apre.toISOString()).toBe('2026-10-29T07:00:00.000Z');
  });
});

describe('quale numero tocca adesso', () => {
  const g = giornata(
    '2026-09-18T20:45:00+02:00', // venerdi'
    '2026-09-20T15:00:00+02:00', // domenica
    '2026-09-21T20:45:00+02:00', // lunedi'
  );
  const a = (iso: string) => decidiUscita(g, new Date(iso));

  it('giovedi\': nessun numero, e dice fra quanto', () => {
    const d = a('2026-09-17T10:00:00+02:00');
    expect(d.uscita).toBe('nessuna');
    expect(d.fraSecondi).toBeGreaterThan(0);
  });

  it('venerdi\' mattina: vigilia', () => {
    expect(a('2026-09-18T08:30:00+02:00').uscita).toBe('vigilia');
  });

  it('venerdi\' alle sette: ancora no', () => {
    expect(a('2026-09-18T07:00:00+02:00').uscita).toBe('nessuna');
  });

  it('sabato, a giornata cominciata: nessun numero', () => {
    // La vigilia e' passata, il retrospettivo non e' ancora il suo momento.
    const d = a('2026-09-19T10:00:00+02:00');
    expect(d.uscita).toBe('nessuna');
    expect(d.motivo).toContain('Giornata in corso');
  });

  it('martedi\' mattina, dopo il posticipo: retrospettivo', () => {
    expect(a('2026-09-22T08:30:00+02:00').uscita).toBe('retrospettivo');
  });

  it('e resta il retrospettivo anche molto dopo: una giornata in ritardo si consegna', () => {
    expect(a('2026-09-25T19:00:00+02:00').uscita).toBe('retrospettivo');
  });

  it('senza calendario non blocca niente: decide la macchina a stati', () => {
    /**
     * Un orario mancante e' un'informazione che non abbiamo, non un divieto. Se
     * fermasse le uscite, un fornitore che smette di pubblicare il calendario
     * spegnerebbe il prodotto per tutti senza un errore.
     */
    const d = decidiUscita({ matchday: 3, partite: [] }, new Date('2026-09-22T08:30:00+02:00'));
    expect(d.uscita).toBe('retrospettivo');
    expect(d.motivo).toContain('macchina a stati');
  });

  it('l\'attesa dichiarata porta davvero al momento giusto', () => {
    // Chi la rispetta deve svegliarsi quando la finestra e' aperta, non prima.
    const adesso = new Date('2026-09-17T10:00:00+02:00');
    const d = decidiUscita(g, adesso);
    const dopo = new Date(adesso.getTime() + d.fraSecondi * 1000);
    expect(decidiUscita(g, dopo).uscita).toBe('vigilia');
  });

  it('l\'ora di uscita si puo\' spostare senza toccare il codice', () => {
    const sera = { ...USCITE_PREDEFINITE, ora: 19, minuto: 30 };
    expect(decidiUscita(g, new Date('2026-09-18T08:30:00+02:00'), sera).uscita).toBe('nessuna');
    expect(decidiUscita(g, new Date('2026-09-18T19:45:00+02:00'), sera).uscita).toBe('vigilia');
  });
});
