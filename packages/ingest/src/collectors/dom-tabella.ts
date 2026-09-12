/**
 * ESTRAZIONE DAL DOM, GUIDATA DAI SELETTORI DEL PROFILO.
 *
 * Il terzo modo di leggere una fonte, dopo il JSON e il JSON dentro l'HTML.
 * Serve al caso piu' scomodo e piu' comune: un sito che i dati li scrive nel
 * documento e basta, senza nessuna risposta JSON da intercettare.
 *
 * PERCHE' UN MOTORE DI SELETTORI VERO E NON DELLE ESPRESSIONI REGOLARI.
 * Perche' i selettori sono un DATO del profilo, aggiornabile senza rilascio —
 * e' la promessa su cui si regge tutta l'ingestione. Con delle regexp scritte
 * a mano quella promessa sarebbe falsa: al primo annidamento in piu' servirebbe
 * un programmatore, cioe' esattamente cio' che il profilo doveva evitare.
 *
 * COSA PRODUCE: un elenco di oggetti piatti, uno per riga, con le chiavi
 * scelte da chi ha scritto il profilo. Da li' in poi la mappatura verso i campi
 * canonici e' la STESSA del percorso JSON: questo modulo aggiunge un passo
 * all'inizio e non cambia niente a valle.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { z } from 'zod';
import { istanteLocale } from '../calendario.js';

export const CampoDomSchema = z.object({
  /** Selettore CSS relativo alla riga. Assente: la riga stessa. */
  selettore: z.string().optional(),
  /**
   * Quale occorrenza prendere, quando il selettore ne trova piu' d'una.
   *
   * Non e' un dettaglio: una pagina di voti puo' avere tre colonne identiche —
   * tre testate che votano lo stesso giocatore — e distinguerle e' una
   * decisione di prodotto, non di codice.
   */
  indice: z.number().int().min(0).default(0),
  /**
   * Da dove si legge il valore:
   * - `testo`: il testo dell'elemento, ripulito;
   * - `attributo`: il valore di `attributo`;
   * - `classe`: l'elenco delle classi, utile quando un'informazione e' scritta
   *   li' e non altrove (un cartellino giallo puo' essere una classe sul voto);
   * - `presenza`: "1" se il selettore trova qualcosa, altrimenti vuoto.
   */
  da: z.enum(['testo', 'attributo', 'classe', 'presenza']).default('testo'),
  attributo: z.string().optional(),
  /**
   * Espressione regolare. Senza `componi` si tiene il primo gruppo.
   *
   * Con `componi` i gruppi si possono ricomporre in un altro ordine: e' cio'
   * che serve per una data scritta all'italiana, dove l'ordine dei numeri e'
   * l'opposto di quello che serve. Farlo qui e non a valle e' deliberato:
   * `05/09/2026` dato in pasto a un parser di date diventa il 9 maggio in
   * mezzo mondo, e sarebbe una data valida — quindi nessun controllo la
   * fermerebbe.
   */
  estrai: z.string().optional(),
  /** Modello sui gruppi di `estrai`: `$1`..`$9`. */
  componi: z.string().optional(),
  /**
   * Il fuso in cui leggere un orario «da parete».
   *
   * Un sito scrive «20:45» e intende le 20:45 a Roma. Conservarlo come
   * `2026-09-05T20:45` senza fuso significa farlo interpretare dall'orologio di
   * chi legge: su un server in UTC diventano le 22:45, e l'ora di uscita del
   * giornale sbaglia di due ore — una, sei mesi l'anno, che e' il modo piu'
   * subdolo di sbagliare.
   */
  fuso: z.string().optional(),
  /** Traduzione di valori. Un valore non elencato passa invariato. */
  mappa: z.record(z.string()).optional(),
  /**
   * I valori che significano «non c'e'», e diventano null.
   *
   * Esiste perche' i siti veri usano dei segnaposto: un voto scritto `55` puo'
   * non essere 5,5 ma «senza voto». Leggerlo come numero darebbe un
   * cinquantacinque, e nessun controllo a valle lo distinguerebbe da un voto
   * vero fuori scala.
   */
  vuotoSe: z.array(z.string()).default([]),
  numero: z.boolean().default(false),
});
export type CampoDom = z.infer<typeof CampoDomSchema>;

export const SelettoriDomSchema = z.object({
  /**
   * Campi letti UNA volta sul documento e ripetuti su ogni riga.
   *
   * Servono ai fatti della pagina intera, non della riga: qual e' la giornata
   * che sto guardando. Sembra superfluo — la giornata la si e' chiesta — ed e'
   * invece il controllo piu' importante di tutti: un sito che pubblica «la
   * giornata corrente» a un indirizzo fisso, letto in ritardo, restituisce una
   * giornata DIVERSA da quella attesa. Senza questo campo i voti della 4
   * finirebbero nel giornale della 3 con i numeri tutti giusti e tutti
   * sbagliati, e nessun controllo a valle potrebbe accorgersene.
   */
  documento: z.record(CampoDomSchema).default({}),
  /**
   * Un contenitore che porta valori comuni a tutte le sue righe.
   *
   * Serve quando un dato della riga non sta nella riga: in una pagina di voti
   * la squadra e il risultato stanno nell'intestazione della tabella, e le
   * righe sotto non li ripetono.
   */
  gruppo: z.object({
    selettore: z.string().min(1),
    campi: z.record(CampoDomSchema).default({}),
  }).optional(),
  /** Il selettore di una riga: e' l'equivalente di `root` nel percorso JSON. */
  riga: z.string().min(1),
  campi: z.record(CampoDomSchema),
});
export type SelettoriDom = z.infer<typeof SelettoriDomSchema>;

/** Il testo di un elemento, con gli spazi ridotti a uno. */
function testoPulito(el: HTMLElement): string {
  return el.text.replace(/\s+/g, ' ').trim();
}

function grezzo(el: HTMLElement, campo: CampoDom): string {
  switch (campo.da) {
    case 'attributo':
      return campo.attributo ? el.getAttribute(campo.attributo) ?? '' : '';
    case 'classe':
      return el.getAttribute('class') ?? '';
    case 'presenza':
      return '1';
    default:
      return testoPulito(el);
  }
}

/**
 * Il valore di un campo dentro un elemento.
 *
 * L'ordine dei passaggi e' deliberato: prima si trova l'elemento, poi si legge,
 * poi si estrae, poi si traduce, POI si guarda se e' un segnaposto vuoto, e
 * solo alla fine si converte in numero. Mettere la conversione prima del
 * segnaposto trasformerebbe «senza voto» in un numero, che e' il difetto che
 * `vuotoSe` esiste per impedire.
 */
export function leggiCampo(dentro: HTMLElement, campo: CampoDom): string | number | null {
  const trovati = campo.selettore ? dentro.querySelectorAll(campo.selettore) : [dentro];
  const el = trovati[campo.indice];
  if (el === undefined) return campo.da === 'presenza' ? '' : null;

  let valore = grezzo(el, campo);

  if (campo.estrai !== undefined) {
    const m = new RegExp(campo.estrai).exec(valore);
    // Senza corrispondenza il campo non c'e': meglio un buco dichiarato di un
    // valore preso per intero che sembra giusto e non lo e'.
    if (m === null) return null;
    valore = campo.componi === undefined
      ? m[1] ?? m[0]
      : campo.componi.replace(/\$([1-9])/g, (_, n: string) => m[Number(n)] ?? '');
  }

  if (campo.fuso !== undefined) {
    const istante = istanteDaParete(valore, campo.fuso);
    if (istante === null) return null;
    valore = istante;
  }

  if (campo.mappa !== undefined && campo.mappa[valore] !== undefined) {
    valore = campo.mappa[valore] as string;
  }

  if (valore === '' || campo.vuotoSe.includes(valore)) return campo.da === 'presenza' ? '' : null;

  if (campo.numero) {
    // La virgola decimale all'italiana. I separatori di migliaia non si tolgono
    // di proposito: su voti e bonus non esistono, e toglierli renderebbe «1.234»
    // indistinguibile da milleduecentotrentaquattro e da uno virgola due.
    const n = Number.parseFloat(valore.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return valore;
}

/**
 * Da «2026-09-05T20:45» piu' un fuso all'istante assoluto.
 *
 * La conversione la fa `istanteLocale`, che nel progetto esiste gia' e sa
 * correggere i due giorni dell'anno in cui l'ora di parete e lo scarto dal
 * fuso non stanno insieme. Rifarla qui a mano significherebbe sbagliarla in un
 * secondo posto.
 */
function istanteDaParete(valore: string, fuso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(valore);
  if (m === null) return null;
  const [, anno, mese, giorno, ora, minuto] = m as unknown as string[];
  try {
    return istanteLocale(
      { anno: Number(anno), mese: Number(mese), giorno: Number(giorno) },
      Number(ora), Number(minuto), fuso,
    ).toISOString();
  } catch {
    // Un fuso che non esiste e' un profilo sbagliato, non un dato sbagliato:
    // meglio un buco dichiarato che un orario inventato.
    return null;
  }
}

export type RigaDom = Record<string, string | number | null>;

export function estraiDaDom(html: string, selettori: SelettoriDom): RigaDom[] {
  const documento = parse(html);
  const righe: RigaDom[] = [];

  const diPagina: RigaDom = {};
  for (const [nome, campo] of Object.entries(selettori.documento)) {
    diPagina[nome] = leggiCampo(documento as unknown as HTMLElement, campo);
  }

  const contenitori = selettori.gruppo
    ? documento.querySelectorAll(selettori.gruppo.selettore)
    : [documento as unknown as HTMLElement];

  for (const contenitore of contenitori) {
    const comuni: RigaDom = {};
    if (selettori.gruppo) {
      for (const [nome, campo] of Object.entries(selettori.gruppo.campi)) {
        comuni[nome] = leggiCampo(contenitore, campo);
      }
    }
    for (const riga of contenitore.querySelectorAll(selettori.riga)) {
      const uscita: RigaDom = { ...diPagina, ...comuni };
      for (const [nome, campo] of Object.entries(selettori.campi)) {
        uscita[nome] = leggiCampo(riga, campo);
      }
      righe.push(uscita);
    }
  }
  return righe;
}
