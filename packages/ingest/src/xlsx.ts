import { inflateRawSync } from 'node:zlib';

/**
 * UN LETTORE XLSX MINIMO, SENZA DIPENDENZE.
 *
 * Perche' non una libreria: questo modulo legge un file caricato da un
 * estraneo, ed e' il pezzo di codice con la superficie d'attacco piu' larga
 * di tutto il prodotto. Le librerie generaliste per xlsx trattano formule,
 * macro, riferimenti esterni e VML — cioe' un'enorme quantita' di
 * funzionalita' che a noi non serve e che va comunque difesa. Qui serve una
 * cosa sola: leggere le celle di un foglio. Duecento righe che fanno solo
 * quello si leggono per intero in mezz'ora, e non portano dentro un albero
 * di dipendenze transitive che nessuno rileggera' mai.
 *
 * Cio' che il lettore DEVE reggere non e' il file che l'utente scarica, ma
 * quello che ricarica: passato da Excel, LibreOffice, Numbers o Fogli Google,
 * lo stesso contenuto cambia codifica — le stringhe migrano da `inlineStr` a
 * `sharedStrings`, le celle vengono compresse invece che memorizzate, i totali
 * diventano formule con il valore in cache. Sono tutte varianti legittime
 * dello stesso foglio, e vanno lette tutte.
 */

/** Limiti su un file che arriva da fuori: uno zip si dichiara piccolo e si espande enorme. */
const MAX_VOCI = 512;
const MAX_BYTE_VOCE = 32 * 1024 * 1024;
const MAX_BYTE_TOTALE = 64 * 1024 * 1024;

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

type VoceZip = { nome: string; metodo: number; offsetLocale: number; dimensione: number };

/**
 * Legge lo zip partendo dal DIRECTORY CENTRALE, non dagli header locali.
 *
 * Non e' pignoleria: quando un file viene scritto in streaming le dimensioni
 * nell'header locale sono zero e quelle vere stanno in un descrittore dopo i
 * dati. Il directory centrale e' l'unica fonte che vale sempre.
 */
function vociZip(buf: Buffer): Map<string, VoceZip> {
  const FINE_DIR = 0x06054b50;
  let fine = -1;
  // Il commento finale puo' essere lungo fino a 64KiB: si cerca all'indietro.
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === FINE_DIR) { fine = i; break; }
  }
  if (fine < 0) throw new XlsxError('Il file non e\' un archivio valido: non sembra un .xlsx.');

  const quante = buf.readUInt16LE(fine + 10);
  let offset = buf.readUInt32LE(fine + 16);
  if (quante > MAX_VOCI) throw new XlsxError(`Il file contiene troppe parti (${quante}).`);

  const voci = new Map<string, VoceZip>();
  for (let i = 0; i < quante; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new XlsxError('Il file e\' danneggiato: indice interno incoerente.');
    }
    const metodo = buf.readUInt16LE(offset + 10);
    const dimensione = buf.readUInt32LE(offset + 24);
    const lenNome = buf.readUInt16LE(offset + 28);
    const lenExtra = buf.readUInt16LE(offset + 30);
    const lenCommento = buf.readUInt16LE(offset + 32);
    const offsetLocale = buf.readUInt32LE(offset + 42);
    const nome = buf.subarray(offset + 46, offset + 46 + lenNome).toString('utf8');
    voci.set(nome, { nome, metodo, offsetLocale, dimensione });
    offset += 46 + lenNome + lenExtra + lenCommento;
  }
  return voci;
}

function leggiVoce(buf: Buffer, voce: VoceZip, giaLetti: { byte: number }): string {
  if (voce.dimensione > MAX_BYTE_VOCE) {
    throw new XlsxError(`La parte "${voce.nome}" e\' troppo grande.`);
  }
  const off = voce.offsetLocale;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
    throw new XlsxError('Il file e\' danneggiato: intestazione interna assente.');
  }
  const lenNome = buf.readUInt16LE(off + 26);
  const lenExtra = buf.readUInt16LE(off + 28);
  const inizio = off + 30 + lenNome + lenExtra;

  let dati: Buffer;
  if (voce.metodo === 0) {
    dati = buf.subarray(inizio, inizio + voce.dimensione);
  } else if (voce.metodo === 8) {
    // La dimensione compressa dell'header locale puo' essere 0 (streaming):
    // si inflaziona dal punto d'inizio e si lascia decidere allo stream.
    dati = inflateRawSync(buf.subarray(inizio), { maxOutputLength: MAX_BYTE_VOCE });
  } else {
    throw new XlsxError(`La parte "${voce.nome}" usa una compressione non supportata.`);
  }

  giaLetti.byte += dati.length;
  if (giaLetti.byte > MAX_BYTE_TOTALE) throw new XlsxError('Il file si espande oltre il limite consentito.');
  return dati.toString('utf8');
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Si legge l'XML con espressioni regolari, e qui e' difendibile: in un foglio
 * di calcolo OGNI testo e' per definizione gia' passato dall'escaping XML — un
 * nome di squadra che contiene `</c>` arriva nel file come `&lt;/c&gt;`. Non
 * esiste contenuto che possa chiudere un tag per errore, che e' esattamente
 * l'ipotesi che rende fragile il parsing a regex altrove.
 */
function decodifica(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // per ultimo: altrimenti &amp;lt; diventerebbe <
}

/** Concatena tutti i `<t>` di un frammento: una stringa puo' essere spezzata in piu' run formattati. */
function testo(frammento: string): string {
  let out = '';
  for (const m of frammento.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decodifica(m[1] ?? '');
  }
  return out;
}

function stringheCondivise(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g)) {
    out.push(testo(m[1] ?? ''));
  }
  return out;
}

/** "AB27" -> { colonna: 28, riga: 27 }. La colonna e' 1-based come in Excel. */
export function riferimento(ref: string): { colonna: number; riga: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let colonna = 0;
  for (const ch of m[1]!) colonna = colonna * 26 + (ch.charCodeAt(0) - 64);
  return { colonna, riga: Number(m[2]) };
}

/** 1 -> "A", 28 -> "AB". Serve solo per i messaggi d'errore: un umano legge "colonna AB". */
export function nomeColonna(colonna: number): string {
  let out = '';
  let n = colonna;
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = (n - r - 1) / 26;
  }
  return out;
}

export type Foglio = {
  nome: string;
  /** Chiave "colonna:riga" (entrambe 1-based). Solo celle non vuote. */
  celle: Map<string, string>;
  ultimaRiga: number;
  ultimaColonna: number;
};

export function cella(foglio: Foglio, colonna: number, riga: number): string | undefined {
  return foglio.celle.get(`${colonna}:${riga}`);
}

function leggiFoglio(nome: string, xml: string, condivise: string[]): Foglio {
  const celle = new Map<string, string>();
  let ultimaRiga = 0;
  let ultimaColonna = 0;

  // Si scorre riga per riga: alcuni generatori omettono `r` sulle celle, e in
  // quel caso la posizione e' implicita nell'ordine dentro la riga.
  for (const riga of xml.matchAll(/<row(\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const attrRiga = riga[1] ?? '';
    const numeroRiga = Number(/\sr="(\d+)"/.exec(attrRiga)?.[1] ?? '0');
    if (!numeroRiga) continue;
    let colonnaImplicita = 0;

    for (const c of (riga[2] ?? '').matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = c[1] ?? '';
      const corpo = c[2] ?? '';
      const ref = /\sr="([A-Z]+\d+)"/.exec(attr)?.[1];
      const pos = ref ? riferimento(ref) : null;
      const colonna = pos ? pos.colonna : ++colonnaImplicita;
      if (pos) colonnaImplicita = colonna;

      const tipo = /\st="([^"]+)"/.exec(attr)?.[1] ?? 'n';
      let valore = '';
      if (tipo === 'inlineStr') {
        valore = testo(corpo);
      } else if (tipo === 'e') {
        valore = ''; // #N/D e simili: una cella in errore e' una cella vuota
      } else {
        // `<v>` e' il valore in cache anche quando la cella e' una formula.
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
        if (v !== undefined) {
          valore = tipo === 's'
            ? (condivise[Number(v)] ?? '')
            : tipo === 'b'
              ? (v === '1' ? 'VERO' : 'FALSO')
              : decodifica(v);
        }
      }

      if (valore !== '') {
        celle.set(`${colonna}:${numeroRiga}`, valore);
        if (numeroRiga > ultimaRiga) ultimaRiga = numeroRiga;
        if (colonna > ultimaColonna) ultimaColonna = colonna;
      }
    }
  }

  return { nome, celle, ultimaRiga, ultimaColonna };
}

/**
 * Apre un .xlsx e restituisce i fogli nell'ordine in cui compaiono nel
 * workbook. Solo valori: niente stili, niente formule, niente immagini.
 */
export function leggiXlsx(contenuto: Buffer | Uint8Array): Foglio[] {
  const buf = Buffer.isBuffer(contenuto) ? contenuto : Buffer.from(contenuto);
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new XlsxError('Il file non e\' un .xlsx: manca la firma dell\'archivio.');
  }

  const voci = vociZip(buf);
  const letti = { byte: 0 };
  const prendi = (nome: string): string | null => {
    const voce = voci.get(nome);
    return voce ? leggiVoce(buf, voce, letti) : null;
  };

  const workbook = prendi('xl/workbook.xml');
  if (!workbook) throw new XlsxError('Il file non contiene un foglio di calcolo leggibile.');

  const rels = prendi('xl/_rels/workbook.xml.rels') ?? '';
  const perId = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s([^>]*)\/>/g)) {
    const attr = m[1] ?? '';
    const id = /\bId="([^"]+)"/.exec(attr)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attr)?.[1];
    if (id && target) perId.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const condivise = (() => {
    const xml = prendi('xl/sharedStrings.xml');
    return xml ? stringheCondivise(xml) : [];
  })();

  const fogli: Foglio[] = [];
  for (const m of workbook.matchAll(/<sheet\s([^>]*)\/>/g)) {
    const attr = m[1] ?? '';
    const nome = decodifica(/\bname="([^"]*)"/.exec(attr)?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(attr)?.[1];
    const target = rid ? perId.get(rid) : undefined;
    const xml = target ? prendi(`xl/${target}`) : null;
    if (xml) fogli.push(leggiFoglio(nome, xml, condivise));
  }

  if (fogli.length === 0) throw new XlsxError('Il file non contiene fogli leggibili.');
  return fogli;
}
