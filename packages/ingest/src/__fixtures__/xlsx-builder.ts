import { deflateRawSync } from 'node:zlib';

/**
 * Costruisce file .xlsx per i test.
 *
 * Serve a provare la proprieta' che conta davvero sul lettore: lo stesso
 * foglio, codificato nei modi diversi in cui lo scrivono i programmi veri,
 * deve dare lo stesso identico risultato. Il file che si scarica dalla
 * piattaforma usa stringhe in linea e voci non compresse; appena passa da
 * Excel o LibreOffice diventa stringhe condivise e voci deflazionate, con i
 * totali trasformati in formule. Sono tutte varianti legittime, e senza un
 * generatore non ci sarebbe modo di averle tutte sotto test.
 */

export type Codifica = {
  /** Stringhe in `sharedStrings.xml` invece che dentro la cella. */
  condivise?: boolean;
  /** Voci dello zip compresse (deflate) invece che memorizzate. */
  compresse?: boolean;
  /** La riga «totale» come formula con valore in cache, come la riscrive Excel. */
  totaleComeFormula?: boolean;
  /** Celle senza attributo `r`: la posizione e' implicita nell'ordine. */
  senzaRiferimenti?: boolean;
};

const TABELLA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = TABELLA_CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

type Parte = { nome: string; dati: Buffer };

function scriviZip(parti: Parte[], compresse: boolean): Buffer {
  const locali: Buffer[] = [];
  const centrali: Buffer[] = [];
  let offset = 0;

  for (const p of parti) {
    const crc = crc32(p.dati);
    const corpo = compresse ? deflateRawSync(p.dati) : p.dati;
    const metodo = compresse ? 8 : 0;
    const nome = Buffer.from(p.nome, 'utf8');

    const locale = Buffer.alloc(30 + nome.length);
    locale.writeUInt32LE(0x04034b50, 0);
    locale.writeUInt16LE(20, 4);
    locale.writeUInt16LE(metodo, 8);
    locale.writeUInt32LE(crc, 14);
    locale.writeUInt32LE(corpo.length, 18);
    locale.writeUInt32LE(p.dati.length, 22);
    locale.writeUInt16LE(nome.length, 26);
    nome.copy(locale, 30);
    locali.push(locale, corpo);

    const centrale = Buffer.alloc(46 + nome.length);
    centrale.writeUInt32LE(0x02014b50, 0);
    centrale.writeUInt16LE(20, 4);
    centrale.writeUInt16LE(20, 6);
    centrale.writeUInt16LE(metodo, 10);
    centrale.writeUInt32LE(crc, 16);
    centrale.writeUInt32LE(corpo.length, 20);
    centrale.writeUInt32LE(p.dati.length, 24);
    centrale.writeUInt16LE(nome.length, 28);
    centrale.writeUInt32LE(offset, 42);
    nome.copy(centrale, 46);
    centrali.push(centrale);

    offset += locale.length + corpo.length;
  }

  const dir = Buffer.concat(centrali);
  const fine = Buffer.alloc(22);
  fine.writeUInt32LE(0x06054b50, 0);
  fine.writeUInt16LE(parti.length, 8);
  fine.writeUInt16LE(parti.length, 10);
  fine.writeUInt32LE(dir.length, 12);
  fine.writeUInt32LE(offset, 16);

  return Buffer.concat([...locali, dir, fine]);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Una cella: stringa, numero, o vuota. */
export type Valore = string | number | null;

function nomeColonna(colonna: number): string {
  let out = '';
  let n = colonna;
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = (n - r - 1) / 26;
  }
  return out;
}

/**
 * `griglia[riga][colonna]`, entrambe 0-based; `null` = cella assente.
 * Le formule non si scrivono: `totaleComeFormula` le mette sulle celle che
 * seguono un «totale».
 */
export function costruisciXlsx(
  griglia: Valore[][],
  nomeFoglio = 'ROSE',
  codifica: Codifica = {},
): Buffer {
  const condivise: string[] = [];
  const indiceCondivisa = new Map<string, number>();
  const registra = (s: string): number => {
    const gia = indiceCondivisa.get(s);
    if (gia !== undefined) return gia;
    const i = condivise.length;
    condivise.push(s);
    indiceCondivisa.set(s, i);
    return i;
  };

  const righeXml: string[] = [];
  griglia.forEach((riga, r) => {
    const celle: string[] = [];
    riga.forEach((v, c) => {
      if (v === null || v === '') return;
      const ref = codifica.senzaRiferimenti ? '' : ` r="${nomeColonna(c + 1)}${r + 1}"`;
      if (typeof v === 'number') {
        const precedente = riga[c - 1];
        const eTotale = typeof precedente === 'string' && precedente.trim().toLowerCase() === 'totale';
        celle.push(
          codifica.totaleComeFormula && eTotale
            ? `<c${ref}><f>SUM(${nomeColonna(c + 1)}2:${nomeColonna(c + 1)}${r})</f><v>${v}</v></c>`
            : `<c${ref}><v>${v}</v></c>`,
        );
      } else if (codifica.condivise) {
        celle.push(`<c${ref} t="s"><v>${registra(v)}</v></c>`);
      } else {
        celle.push(`<c${ref} t="inlineStr"><is><t>${esc(v)}</t></is></c>`);
      }
    });
    if (celle.length > 0) righeXml.push(`<row r="${r + 1}">${celle.join('')}</row>`);
  });

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheetData>${righeXml.join('')}</sheetData></worksheet>`;

  const parti: Parte[] = [
    {
      nome: '[Content_Types].xml',
      dati: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '</Types>', 'utf8'),
    },
    {
      nome: '_rels/.rels',
      dati: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>', 'utf8'),
    },
    {
      nome: 'xl/workbook.xml',
      dati: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${esc(nomeFoglio)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8'),
    },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      dati: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>', 'utf8'),
    },
    { nome: 'xl/worksheets/sheet1.xml', dati: Buffer.from(sheet, 'utf8') },
  ];

  if (codifica.condivise) {
    parti.push({
      nome: 'xl/sharedStrings.xml',
      dati: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `count="${condivise.length}" uniqueCount="${condivise.length}">` +
        condivise.map((s) => `<si><t>${esc(s)}</t></si>`).join('') +
        '</sst>', 'utf8'),
    });
  }

  return scriviZip(parti, codifica.compresse ?? false);
}

/* ------------------------------------------------------------------ */
/* Il foglio di prova: stessa forma del file vero della piattaforma.    */
/* ------------------------------------------------------------------ */

export type SquadraProva = { nome: string; giocatori: [string, number][] };

/**
 * Una rosa da 25 con gli stessi tranelli del file vero: accenti, omonimi
 * distinti dalle iniziali, nomi composti, un'apostrofo e una `&` da
 * sottoporre all'escaping.
 */
export function rosaProva(seme: string, varianti: Partial<Record<number, [string, number]>> = {}): [string, number][] {
  const base: [string, number][] = [
    [`Portiere${seme}`, 90], [`Secondo${seme}`, 8], [`Terzo${seme}`, 2],
    [`Difensore${seme}A`, 60], [`Difensore${seme}B`, 40], [`Lucumì${seme}`, 30],
    [`Difensore${seme}D`, 20], [`Difensore${seme}E`, 10], [`Difensore${seme}F`, 6],
    [`Difensore${seme}G`, 3], [`Difensore${seme}H`, 1],
    [`Centrocampista${seme}A`, 100], [`Zè Pedro${seme}`, 50], [`Centrocampista${seme}C`, 30],
    [`Centrocampista${seme}D`, 20], [`Centrocampista${seme}E`, 12], [`Centrocampista${seme}F`, 8],
    [`Centrocampista${seme}G`, 4], [`Centrocampista${seme}H`, 1],
    [`Attaccante${seme}A`, 200], [`Attaccante${seme}B`, 120], [`O'Riley${seme}`, 80],
    [`Attaccante${seme}D`, 60], [`Bell & Co${seme}`, 30], [`Attaccante${seme}F`, 15],
  ];
  for (const [i, v] of Object.entries(varianti)) if (v) base[Number(i)] = v;
  return base;
}

/** Dispone le squadre in orizzontale come fa la piattaforma: nome, costo, colonna vuota. */
export function foglioRose(squadre: SquadraProva[], opzioni: { senzaTotale?: boolean; totaleSbagliato?: number } = {}): Valore[][] {
  const alte = Math.max(...squadre.map((s) => s.giocatori.length));
  const righe: Valore[][] = [];
  const larghezza = squadre.length * 3;

  const intestazione: Valore[] = new Array(larghezza).fill(null);
  squadre.forEach((s, i) => {
    intestazione[i * 3] = s.nome;
    intestazione[i * 3 + 1] = 'costo';
  });
  righe.push(intestazione);

  for (let r = 0; r < alte; r++) {
    const riga: Valore[] = new Array(larghezza).fill(null);
    squadre.forEach((s, i) => {
      const g = s.giocatori[r];
      if (g) { riga[i * 3] = g[0]; riga[i * 3 + 1] = g[1]; }
    });
    righe.push(riga);
  }

  if (!opzioni.senzaTotale) {
    const riga: Valore[] = new Array(larghezza).fill(null);
    squadre.forEach((s, i) => {
      riga[i * 3] = 'totale';
      riga[i * 3 + 1] = opzioni.totaleSbagliato ?? s.giocatori.reduce((a, g) => a + g[1], 0);
    });
    righe.push(riga);
  }

  return righe;
}
