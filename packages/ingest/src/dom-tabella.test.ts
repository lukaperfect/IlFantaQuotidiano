/**
 * I test dell'estrazione dal DOM.
 *
 * Meta' girano su una PAGINA VERA — un ritaglio di quella che pubblica i voti,
 * committato com'era — e meta' su un documento minimo costruito apposta. La
 * divisione non e' casuale: la pagina vera prova la FEDELTA' (che quei
 * selettori, su quel markup, danno quei numeri), il documento minimo prova le
 * PROPRIETA' strutturali, che su 75 KB di HTML altrui sarebbero illeggibili.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estraiDaDom, leggiCampo, SelettoriDomSchema } from './collectors/dom-tabella.js';
import { parse } from 'node-html-parser';

const qui = dirname(fileURLToPath(import.meta.url));
const paginaVera = readFileSync(join(qui, '__fixtures__', 'voti-pagina.html'), 'utf8');

/** I selettori della pagina dei voti, gli stessi che finiscono nel profilo. */
const SELETTORI = SelettoriDomSchema.parse({
  gruppo: {
    selettore: 'li.team-table',
    campi: {
      squadra: { selettore: 'a.team-name', da: 'attributo', attributo: 'href', estrai: '/squadre/([a-z0-9-]+)$' },
      casa: { selettore: '.match-score span', indice: 0 },
      golCasa: { selettore: '.match-score span', indice: 1, numero: true },
      golFuori: { selettore: '.match-score span', indice: 3, numero: true },
      fuori: { selettore: '.match-score span', indice: 4 },
      quando: { selettore: '.match-date' },
    },
  },
  // `:has` esclude la riga dell'allenatore, che un giocatore non e' e un
  // identificatore non ce l'ha.
  riga: 'tbody tr:has(a.player-name)',
  campi: {
    ruolo: { selettore: 'span.role', da: 'attributo', attributo: 'data-value', mappa: { p: 'P', d: 'D', c: 'C', a: 'A' } },
    id: { selettore: 'a.player-name', da: 'attributo', attributo: 'href', estrai: '/(\\d+)$' },
    nome: { selettore: 'a.player-name' },
    voto: { selettore: 'span.player-grade', indice: 0, da: 'attributo', attributo: 'data-value', vuotoSe: ['55'], numero: true },
    fantavoto: { selettore: 'span.player-fanta-grade', indice: 0, da: 'attributo', attributo: 'data-value', vuotoSe: ['55'], numero: true },
    votoStatistico: { selettore: 'span.player-grade', indice: 1, da: 'attributo', attributo: 'data-value', vuotoSe: ['55'], numero: true },
    cartellino: { selettore: 'span.player-grade', indice: 0, da: 'classe', estrai: '(yellow-card|red-card)' },
    gol: { selettore: 'span.player-bonus[title="Gol segnati"]', da: 'attributo', attributo: 'data-value', numero: true },
    subiti: { selettore: 'span.player-bonus[title="Gol subiti"]', da: 'attributo', attributo: 'data-value', numero: true },
    subentrato: { selettore: 'img[title="Subentrato"]', da: 'presenza' },
  },
});

const righe = estraiDaDom(paginaVera, SELETTORI);
const di = (nome: string) => righe.find((r) => r.nome === nome);

describe('estrazione dal DOM, sulla pagina vera', () => {
  it('trova i giocatori e non l\'allenatore', () => {
    expect(righe).toHaveLength(16);
    expect(righe.every((r) => r.id !== null)).toBe(true);
    expect(righe.some((r) => r.ruolo === 'all')).toBe(false);
  });

  it('porta su ogni riga cio\' che sta nell\'intestazione della tabella', () => {
    // La squadra, il risultato e l'orario non stanno nella riga del giocatore:
    // senza il gruppo sarebbero irrecuperabili.
    expect(di('Carnesecchi')).toMatchObject({
      squadra: 'atalanta', casa: 'Roma', golCasa: 2, golFuori: 1, fuori: 'Atalanta',
      quando: '05/09/2026 - 20:45',
    });
  });

  it('legge la virgola decimale all\'italiana', () => {
    expect(di('Zappacosta')?.voto).toBe(5.5);
    expect(di('Kolasinac')?.voto).toBe(6.5);
  });

  it('prende il cartellino dalla CLASSE del voto, dove il sito lo scrive', () => {
    expect(di('Bellanova')?.cartellino).toBe('yellow-card');
    expect(di('Gaetano')?.cartellino).toBe('red-card');
    expect(di('Scalvini')?.cartellino).toBeNull();
  });

  it('l\'aritmetica del fantavoto torna con i cartellini letti cosi\'', () => {
    // E' la prova che la lettura e' giusta e non solo plausibile: giallo -0,5,
    // rosso -1, gol +3.
    expect(di('Bellanova')?.fantavoto).toBe(5);        // 5,5 - 0,5
    expect(di('Gaetano')?.fantavoto).toBe(4.5);        // 5,5 - 1
    expect(di('Ederson D.S.')).toMatchObject({ voto: 7, gol: 1, fantavoto: 10 });
    expect(di('Carnesecchi')).toMatchObject({ voto: 7, subiti: 2, fantavoto: 5 });
  });

  it('`55` e\' «senza voto», non cinquantacinque', () => {
    expect(di('Kessiè')).toMatchObject({ voto: null, fantavoto: null });
  });

  it('e resta «senza voto» anche col cartellino, che e\' il caso che lo dimostra', () => {
    // Un giocatore ammonito con voto 55 ha fantavoto 55: se 55 fosse 5,5 il
    // giallo lo porterebbe a 5. Non lo porta, perche' non c'e' voto a cui
    // togliere mezzo punto.
    const ammonitiSenzaVoto = righe.filter((r) => r.cartellino !== null && r.voto === null);
    for (const r of ammonitiSenzaVoto) expect(r.fantavoto).toBeNull();
  });

  it('l\'indice distingue le tre testate che votano lo stesso giocatore', () => {
    expect(di('Kessiè')?.voto).toBeNull();
    expect(di('Kessiè')?.votoStatistico).toBe(6);
  });

  it('la presenza di un\'icona diventa un campo', () => {
    expect(di('Zappacosta')?.subentrato).toBe('1');
    expect(di('Carnesecchi')?.subentrato).toBe('');
  });
});

/* ------------------------------------------------------------------ */

const MINIMO = `
<ul>
  <li class="g" data-squadra="alfa">
    <table><tbody>
      <tr><td class="n">Primo</td><td class="v" data-value="6,5">x</td></tr>
      <tr><td class="n">Secondo</td><td class="v" data-value="7">y</td></tr>
    </tbody></table>
  </li>
  <li class="g" data-squadra="beta">
    <table><tbody>
      <tr><td class="n">Terzo</td><td class="v" data-value="5">z</td></tr>
    </tbody></table>
  </li>
</ul>`;

const selMinimi = (campi: Record<string, unknown>) => SelettoriDomSchema.parse({
  gruppo: { selettore: 'li.g', campi: { squadra: { da: 'attributo', attributo: 'data-squadra' } } },
  riga: 'tr',
  campi,
});

describe('proprieta\' strutturali', () => {
  it('ogni riga eredita il SUO gruppo, non quello del vicino', () => {
    // Con i gruppi ignorati le righe di beta prenderebbero "alfa" e nessuno
    // se ne accorgerebbe: i numeri sarebbero giusti e attribuiti alla squadra
    // sbagliata, che e' il difetto peggiore di tutti perche' non sembra un bug.
    const out = estraiDaDom(MINIMO, selMinimi({ nome: { selettore: '.n' } }));
    expect(out).toEqual([
      { squadra: 'alfa', nome: 'Primo' },
      { squadra: 'alfa', nome: 'Secondo' },
      { squadra: 'beta', nome: 'Terzo' },
    ]);
  });

  it('un selettore che non trova niente da\' null, non lancia', () => {
    const out = estraiDaDom(MINIMO, selMinimi({ manca: { selettore: '.non-esiste' } }));
    expect(out.every((r) => r.manca === null)).toBe(true);
  });

  it('un\'estrazione senza corrispondenza da\' null, non la stringa intera', () => {
    // Il ripiego "tieni tutto" darebbe un valore che sembra un dato e non lo e'.
    const out = estraiDaDom(MINIMO, selMinimi({
      cifra: { selettore: '.n', estrai: '(\\d+)' },
    }));
    expect(out.every((r) => r.cifra === null)).toBe(true);
  });

  it('il segnaposto vuoto si applica PRIMA della conversione a numero', () => {
    // L'ordine e' la garanzia: al contrario, «55» diventerebbe 55 e nessun
    // controllo a valle potrebbe piu' distinguerlo da un voto fuori scala.
    const out = estraiDaDom(MINIMO, selMinimi({
      voto: { selettore: '.v', da: 'attributo', attributo: 'data-value', vuotoSe: ['7'], numero: true },
    }));
    expect(out.map((r) => r.voto)).toEqual([6.5, null, 5]);
  });

  it('la traduzione dei valori vale solo per quelli elencati', () => {
    const out = estraiDaDom(MINIMO, selMinimi({
      nome: { selettore: '.n', mappa: { Primo: '1°' } },
    }));
    expect(out.map((r) => r.nome)).toEqual(['1°', 'Secondo', 'Terzo']);
  });

  it('senza gruppo si legge tutto il documento', () => {
    const out = estraiDaDom(MINIMO, SelettoriDomSchema.parse({
      riga: 'tr', campi: { nome: { selettore: '.n' } },
    }));
    expect(out).toHaveLength(3);
  });

  it('un numero illeggibile e\' un buco, non un NaN che si propaga', () => {
    const el = parse('<b data-value="sei">x</b>').querySelector('b')!;
    expect(leggiCampo(el, SelettoriDomSchema.parse({
      riga: 'x', campi: { a: { da: 'attributo', attributo: 'data-value', numero: true } },
    }).campi.a!)).toBeNull();
  });
});

describe('la giornata dichiarata dalla pagina', () => {
  it('si legge dal documento e finisce su ogni riga', () => {
    // La pagina dei voti dichiara la propria giornata nel menu, con l'opzione
    // selezionata. E' il dato che permette di rifiutare una pagina che parla di
    // un'altra giornata invece di pubblicarla come se fosse quella giusta.
    const sel = SelettoriDomSchema.parse({
      documento: {
        giornata: {
          selettore: 'select#matchweek option[selected]',
          da: 'attributo', attributo: 'value', numero: true,
        },
      },
      riga: 'tbody tr:has(a.player-name)',
      campi: { nome: { selettore: 'a.player-name' } },
    });
    const out = estraiDaDom(paginaVera, sel);
    expect(out).toHaveLength(16);
    expect(out.every((r) => r.giornata === 3)).toBe(true);
  });

  it('un campo della riga vince su uno di pagina con lo stesso nome', () => {
    // L'ordine di precedenza e' dal generale al particolare: pagina, gruppo,
    // riga. Al contrario un dato di pagina sovrascriverebbe quello della riga,
    // che e' il piu' specifico e quindi il piu' giusto.
    const sel = SelettoriDomSchema.parse({
      documento: { nome: { selettore: 'title' } },
      riga: 'tbody tr:has(a.player-name)',
      campi: { nome: { selettore: 'a.player-name' } },
    });
    expect(estraiDaDom(paginaVera, sel)[0]?.nome).toBe('Carnesecchi');
  });
});

describe('date e fusi, che e\' dove i dati veri fanno male', () => {
  const orario = (campo: Record<string, unknown>) => estraiDaDom(paginaVera, SelettoriDomSchema.parse({
    gruppo: { selettore: 'li.team-table', campi: { quando: campo } },
    riga: 'tbody tr:has(a.player-name)',
    campi: {},
  }))[0]?.quando;

  it('ricompone una data italiana nell\'ordine giusto', () => {
    // Sulla pagina c'e' «05/09/2026 - 20:45». Senza ricomporla, un parser di
    // date la legge come 9 maggio in mezzo mondo — e 9 maggio e' una data
    // valida, quindi nessun controllo a valle la fermerebbe.
    expect(orario({
      selettore: '.match-date',
      estrai: '(\\d{2})/(\\d{2})/(\\d{4}) - (\\d{2}):(\\d{2})',
      componi: '$3-$2-$1T$4:$5',
    })).toBe('2026-09-05T20:45');
  });

  it('e la trasforma in un istante assoluto, col fuso dichiarato', () => {
    // 20:45 a Roma in settembre sono le 18:45 in UTC: due ore.
    expect(orario({
      selettore: '.match-date',
      estrai: '(\\d{2})/(\\d{2})/(\\d{4}) - (\\d{2}):(\\d{2})',
      componi: '$3-$2-$1T$4:$5',
      fuso: 'Europe/Rome',
    })).toBe('2026-09-05T18:45:00.000Z');
  });

  it('l\'ora di parete resta la stessa nei due lati del cambio d\'ora', () => {
    // E' la prova che la conversione non e' uno scarto fisso. La stessa
    // 20:45 vale 18:45Z in ora estiva e 19:45Z in ora solare.
    const parete = (giorno: string) => leggiCampo(
      parse(`<b>${giorno} - 20:45</b>`).querySelector('b')!,
      SelettoriDomSchema.parse({
        riga: 'x',
        campi: { q: {
          estrai: '(\\d{2})/(\\d{2})/(\\d{4}) - (\\d{2}):(\\d{2})',
          componi: '$3-$2-$1T$4:$5', fuso: 'Europe/Rome',
        } },
      }).campi.q!,
    );
    expect(parete('20/09/2026')).toBe('2026-09-20T18:45:00.000Z');
    expect(parete('20/11/2026')).toBe('2026-11-20T19:45:00.000Z');
  });

  it('un orario che non ha la forma attesa e\' un buco, non un\'invenzione', () => {
    expect(orario({ selettore: '.match-date', fuso: 'Europe/Rome' })).toBeNull();
  });
});
