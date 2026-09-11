import { describe, expect, it } from 'vitest';
import { AdapterError } from './adapter.js';
import { importaRoseXlsx, chiaveGiocatore, LAYOUT_CLASSIC } from './collectors/rose-xlsx.js';
import { leggiXlsx, cella, riferimento, nomeColonna } from './xlsx.js';
import {
  costruisciXlsx, foglioRose, rosaProva, type Codifica, type SquadraProva,
} from './__fixtures__/xlsx-builder.js';

const DUE_SQUADRE: SquadraProva[] = [
  { nome: 'ASD Prova', giocatori: rosaProva('Uno') },
  { nome: 'Altra Squadra FC', giocatori: rosaProva('Due') },
];

function file(squadre: SquadraProva[], codifica: Codifica = {}, opzioni = {}) {
  return costruisciXlsx(foglioRose(squadre, opzioni), 'ROSE', codifica);
}

function errore(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    return (e as Error).message;
  }
  throw new Error('non ha lanciato: la garanzia non e\' applicata');
}

describe('lettore xlsx', () => {
  it('riferimento e nome colonna sono inversi anche oltre la Z', () => {
    for (const [ref, col, riga] of [['A1', 1, 1], ['B27', 2, 27], ['AA3', 27, 3], ['AC27', 29, 27]] as const) {
      expect(riferimento(ref)).toEqual({ colonna: col, riga });
      expect(nomeColonna(col)).toBe(ref.replace(/\d+$/, ''));
    }
  });

  it('legge il nome del foglio', () => {
    const fogli = leggiXlsx(costruisciXlsx([['x']], 'ROSE'));
    expect(fogli).toHaveLength(1);
    expect(fogli[0]!.nome).toBe('ROSE');
  });

  it('un file che non e\' uno zip da un errore leggibile, non un\'eccezione qualunque', () => {
    const messaggio = errore(() => importaRoseXlsx(Buffer.from('questo non e un xlsx')));
    expect(messaggio).toContain('.xlsx');
  });

  it('uno zip valido senza workbook non passa per buono', () => {
    // Solo l'intestazione minima di uno zip vuoto.
    const vuoto = Buffer.alloc(22);
    vuoto.writeUInt32LE(0x06054b50, 0);
    expect(() => importaRoseXlsx(vuoto)).toThrow(AdapterError);
  });
});

describe('rose da leghe.fantacalcio.it', () => {
  /**
   * LA PROPRIETA' CHE CONTA DAVVERO.
   *
   * Il file che l'admin scarica usa stringhe in linea e voci non compresse.
   * Quello che ricarica e' passato da Excel: stringhe condivise, voci
   * deflazionate, totali diventati formule, a volte celle senza riferimento.
   * Sono lo stesso foglio e devono dare lo stesso identico risultato — se il
   * lettore dipendesse dalla codifica, funzionerebbe in prova e fallirebbe al
   * primo utente vero.
   */
  const codifiche: [string, Codifica][] = [
    ['come lo scarica la piattaforma (in linea, non compresso)', {}],
    ['come lo risalva Excel (condivise, deflate)', { condivise: true, compresse: true }],
    ['con il totale diventato una formula', { condivise: true, totaleComeFormula: true }],
    ['con celle senza attributo di riferimento', { senzaRiferimenti: true }],
    ['condivise ma non compresse', { condivise: true }],
    ['in linea ma compresse', { compresse: true }],
  ];

  const atteso = importaRoseXlsx(file(DUE_SQUADRE));

  for (const [descrizione, codifica] of codifiche) {
    it(`da lo stesso risultato ${descrizione}`, () => {
      const esito = importaRoseXlsx(file(DUE_SQUADRE, codifica));
      expect(esito.squadre).toEqual(atteso.squadre);
      expect(esito.righe).toEqual(atteso.righe);
      expect(esito.diagnostica.giocatori).toBe(50);
      expect(esito.diagnostica.totaliVerificati).toBe(2);
    });
  }

  it('assegna i ruoli per posizione secondo il layout classico', () => {
    const esito = importaRoseXlsx(file(DUE_SQUADRE));
    for (const squadra of esito.squadre) {
      const conta = (r: string) => squadra.giocatori.filter((g) => g.role === r).length;
      expect([conta('P'), conta('D'), conta('C'), conta('A')]).toEqual([3, 8, 8, 6]);
      // L'ordine, non solo il conteggio: il terzo e' l'ultimo portiere e il
      // quarto il primo difensore. E' li' che un fuori-di-uno si vedrebbe.
      expect(squadra.giocatori[2]!.role).toBe('P');
      expect(squadra.giocatori[3]!.role).toBe('D');
      expect(squadra.giocatori[10]!.role).toBe('D');
      expect(squadra.giocatori[11]!.role).toBe('C');
      expect(squadra.giocatori[18]!.role).toBe('C');
      expect(squadra.giocatori[19]!.role).toBe('A');
    }
    expect(LAYOUT_CLASSIC.reduce((a, [, n]) => a + n, 0)).toBe(25);
  });

  it('porta dentro il prezzo d\'asta e la somma dei crediti', () => {
    const esito = importaRoseXlsx(file(DUE_SQUADRE));
    const squadra = esito.squadre[0]!;
    expect(squadra.giocatori[0]!.purchasePrice).toBe(90);
    expect(squadra.crediti).toBe(squadra.giocatori.reduce((a, g) => a + g.purchasePrice, 0));
    expect(squadra.totaleDichiarato).toBe(squadra.crediti);
  });

  it('produce righe piatte nella stessa forma del CSV delle rose', () => {
    const esito = importaRoseXlsx(file(DUE_SQUADRE));
    expect(esito.righe).toHaveLength(50);
    expect(Object.keys(esito.righe[0]!).sort()).toEqual(
      ['playerId', 'playerName', 'purchasePrice', 'role', 'teamId', 'teamName'],
    );
  });

  it('rileva le squadre dal marcatore «costo», non da un passo fisso di colonne', () => {
    // Stesse due squadre ma con DUE colonne vuote di stacco invece di una.
    const righe = foglioRose(DUE_SQUADRE).map((r) => [
      ...r.slice(0, 3), null, ...r.slice(3),
    ]);
    const esito = importaRoseXlsx(costruisciXlsx(righe));
    expect(esito.squadre.map((s) => s.teamName)).toEqual(['ASD Prova', 'Altra Squadra FC']);
  });

  it('senza la riga «totale» importa lo stesso, ma dichiara di non aver verificato', () => {
    const esito = importaRoseXlsx(file(DUE_SQUADRE, {}, { senzaTotale: true }));
    expect(esito.diagnostica.giocatori).toBe(50);
    expect(esito.diagnostica.totaliVerificati).toBe(0);
    expect(esito.squadre[0]!.totaleDichiarato).toBeNull();
  });
});

describe('le garanzie sul file delle rose', () => {
  /**
   * Ogni prova qui rompe UNA invariante e pretende il messaggio giusto. Sono
   * le prove che darebbero verde su un importatore che non controlla niente,
   * se non fossero scritte al contrario: qui il verde e' il rifiuto.
   */

  it('rifiuta una rosa con un giocatore in meno invece di scalare i ruoli', () => {
    const mutilata: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: rosaProva('Uno').slice(0, 24) },
      DUE_SQUADRE[1]!,
    ];
    const messaggio = errore(() => importaRoseXlsx(file(mutilata)));
    expect(messaggio).toContain('ASD Prova');
    expect(messaggio).toContain('24 giocatori invece di 25');
    expect(messaggio).toContain('ruolo');
  });

  it('rifiuta una rosa con un giocatore in piu\'', () => {
    const gonfia: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: [...rosaProva('Uno'), ['Extra', 1]] },
      DUE_SQUADRE[1]!,
    ];
    expect(errore(() => importaRoseXlsx(file(gonfia)))).toContain('26 giocatori invece di 25');
  });

  it('rifiuta quando i costi non tornano con la riga «totale»', () => {
    // Il conteggio delle righe e' giusto: solo il checksum puo' coglierlo.
    const messaggio = errore(() => importaRoseXlsx(file(DUE_SQUADRE, {}, { totaleSbagliato: 9999 })));
    expect(messaggio).toContain('9999');
    expect(messaggio).toContain('totale');
  });

  it('il checksum coglie un costo corretto a mano, che il conteggio non vede', () => {
    const alterata: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: rosaProva('Uno', { 0: ['PortiereUno', 940] }) },
      DUE_SQUADRE[1]!,
    ];
    // Il totale resta quello giusto dell'originale: 25 righe, somma diversa.
    const righe = foglioRose(alterata);
    const ultima = righe[righe.length - 1]!;
    ultima[1] = rosaProva('Uno').reduce((a, g) => a + g[1], 0);
    const messaggio = errore(() => importaRoseXlsx(costruisciXlsx(righe)));
    expect(messaggio).toContain('ASD Prova');
    expect(messaggio).toMatch(/somm/i);
  });

  it('rifiuta lo stesso giocatore in due squadre', () => {
    const doppio: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: rosaProva('Uno') },
      { nome: 'Altra Squadra FC', giocatori: rosaProva('Due', { 0: ['PortiereUno', 90] }) },
    ];
    const messaggio = errore(() => importaRoseXlsx(file(doppio)));
    expect(messaggio).toContain('PortiereUno');
    expect(messaggio).toContain('ASD Prova');
    expect(messaggio).toContain('Altra Squadra FC');
    expect(messaggio).toContain('asta');
  });

  it('rifiuta due nomi diversi che collassano sullo stesso identificatore', () => {
    const collisione: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: rosaProva('Uno', { 0: ['Rossi A.', 90] }) },
      { nome: 'Altra Squadra FC', giocatori: rosaProva('Due', { 0: ['rossi  a', 90] }) },
    ];
    const messaggio = errore(() => importaRoseXlsx(file(collisione)));
    expect(messaggio).toContain('rossi-a');
    expect(messaggio).toContain('due giocatori diversi');
  });

  it('rifiuta due squadre con lo stesso nome', () => {
    const gemelle: SquadraProva[] = [
      { nome: 'ASD Prova', giocatori: rosaProva('Uno') },
      { nome: 'asd  prova', giocatori: rosaProva('Due') },
    ];
    expect(errore(() => importaRoseXlsx(file(gemelle)))).toMatch(/stesso modo/i);
  });

  it('rifiuta un costo che non e\' un numero, dicendo quale cella', () => {
    const righe = foglioRose(DUE_SQUADRE);
    righe[1]![1] = 'novanta';
    const messaggio = errore(() => importaRoseXlsx(costruisciXlsx(righe)));
    expect(messaggio).toContain('non e\' un numero');
    expect(messaggio).toContain('B2');
  });

  it('rifiuta un costo negativo', () => {
    const righe = foglioRose(DUE_SQUADRE);
    righe[1]![1] = -5;
    expect(errore(() => importaRoseXlsx(costruisciXlsx(righe)))).toContain('negativo');
  });

  it('spiega cosa cerca quando non trova nessuna colonna «costo»', () => {
    const righe = foglioRose(DUE_SQUADRE);
    for (const r of righe) if (r[1] === 'costo') r[1] = 'prezzo';
    righe[0]![1] = 'prezzo';
    righe[0]![4] = 'prezzo';
    const messaggio = errore(() => importaRoseXlsx(costruisciXlsx(righe)));
    expect(messaggio).toContain('costo');
    expect(messaggio).toContain('ROSE');
  });

  it('rifiuta una colonna «costo» senza nome squadra accanto', () => {
    const righe = foglioRose(DUE_SQUADRE);
    righe[0]![0] = null;
    expect(errore(() => importaRoseXlsx(costruisciXlsx(righe)))).toContain('nome della squadra');
  });

  it('dice quali fogli ci sono quando quello chiesto non esiste', () => {
    const messaggio = errore(() => importaRoseXlsx(file(DUE_SQUADRE), { foglio: 'ALTRO' }));
    expect(messaggio).toContain('ROSE');
  });
});

describe('la chiave del giocatore', () => {
  it('tiene distinti gli omonimi separati dalle iniziali', () => {
    // E' il caso vero: Marcus e Khephren Thuram sono due persone diverse in
    // due squadre diverse, e la piattaforma li separa solo con un'iniziale.
    for (const [a, b] of [
      ['Thuram', 'Thuram K.'],
      ['Adams C.', 'Adams A.'],
      ['Esposito Se.', 'Esposito F.P.'],
      ['Rrahmani', 'Rrahmani Al.'],
      ['Martinez L.', 'Martinez Jo.'],
    ]) {
      expect(chiaveGiocatore(a!)).not.toBe(chiaveGiocatore(b!));
    }
  });

  it('toglie gli accenti senza fondere nomi diversi', () => {
    expect(chiaveGiocatore('Lucumì')).toBe('lucumi');
    expect(chiaveGiocatore('Zè Pedro')).toBe('ze-pedro');
    expect(chiaveGiocatore('Cissè A.')).toBe('cisse-a');
    expect(chiaveGiocatore('Milinkovic-Savic V.')).toBe('milinkovic-savic-v');
    expect(chiaveGiocatore("O'Riley")).toBe('o-riley');
  });

  it('e\' stabile: la stessa scrittura da sempre la stessa chiave', () => {
    expect(chiaveGiocatore('  Dodò  ')).toBe(chiaveGiocatore('Dodò'));
  });
});
