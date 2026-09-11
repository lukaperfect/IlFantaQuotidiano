/**
 * IL CALENDARIO DELLA GIORNATA, E LE DUE USCITE CHE NE DISCENDONO.
 *
 * Il giornale esce due volte per giornata: la vigilia la mattina in cui si
 * comincia a giocare, il retrospettivo la mattina dopo l'ultima partita.
 *
 * QUELLO CHE NON SI PUO' FARE E' METTERLE SU GIORNI FISSI. La Serie A gioca il
 * venerdi' sera, il lunedi' sera, ha turni infrasettimanali e rinvii: una
 * giornata puo' cominciare venerdi' e finire lunedi', oppure stare tutta in un
 * mercoledi'. Un cron fissato al martedi' pubblica giornali sbagliati con
 * puntualita' svizzera — ed e' esattamente cio' che questo modulo sostituisce.
 *
 * Gli orari di Serie A sono un fatto del piano GLOBALE: sono gli stessi per
 * tutte le leghe, quindi si leggono una volta per giornata come i voti.
 */

/** Un calcio d'inizio. Il resto della partita qui non interessa. */
export type PartitaInCalendario = {
  /** Istante del calcio d'inizio, ISO 8601. */
  kickoff: string;
  homeTeam?: string;
  awayTeam?: string;
};

export type CalendarioGiornata = {
  matchday: number;
  /** Le partite della giornata. Vuoto significa «non lo sappiamo». */
  partite: readonly PartitaInCalendario[];
};

export type OpzioniUscite = {
  /** Il fuso in cui «la mattina» vuol dire qualcosa. */
  timezone: string;
  /** A che ora esce il giornale, ora locale. */
  ora: number;
  minuto: number;
};

export const USCITE_PREDEFINITE: OpzioniUscite = {
  timezone: 'Europe/Rome',
  // Le otto: prima che la gente esca di casa, e dopo che i voti della sera
  // precedente si sono assestati.
  ora: 8,
  minuto: 0,
};

/* ------------------------------------------------------------------ *
 * Fuso orario, senza librerie e senza trucchi fragili
 * ------------------------------------------------------------------ */

type OraLocale = {
  anno: number; mese: number; giorno: number; ora: number; minuto: number;
};

/**
 * L'orologio da parete in un fuso, per un dato istante.
 *
 * Usa `formatToParts` e non `toLocaleString` + `new Date(...)`. Quel giro —
 * formattare in una lingua e riparsare la stringa — e' la ricetta classica, e
 * dipende dal formato testuale di una locale: e' corretta finche' qualcuno non
 * cambia runtime o locale predefinita, e allora sbaglia in silenzio di ore.
 * `formatToParts` restituisce i campi, non una frase da interpretare.
 */
export function oraLocale(istante: Date, timezone: string): OraLocale {
  const parti = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(istante);

  const n = (tipo: Intl.DateTimeFormatPartTypes): number => {
    const p = parti.find((x) => x.type === tipo);
    return p ? Number(p.value) : 0;
  };
  return {
    anno: n('year'), mese: n('month'), giorno: n('day'),
    ora: n('hour'), minuto: n('minute'),
  };
}

/** Lo scarto del fuso rispetto a UTC, in minuti, per un dato istante. */
function scartoMinuti(istante: Date, timezone: string): number {
  const l = oraLocale(istante, timezone);
  const comeUtc = Date.UTC(l.anno, l.mese - 1, l.giorno, l.ora, l.minuto);
  // Si azzerano secondi e millisecondi da entrambe le parti, altrimenti lo
  // scarto porta dentro il resto dell'istante invece del solo fuso.
  const originale = Math.floor(istante.getTime() / 60000) * 60000;
  return (comeUtc - originale) / 60000;
}

/**
 * L'istante corrispondente a un'ora da parete in un fuso.
 *
 * DUE PASSATE, e la seconda non e' pignoleria: per sapere quale scarto UTC vale
 * bisogna gia' sapere di che istante si parla, e nei giorni di cambio dell'ora
 * la prima stima cade dal lato sbagliato. Si stima, si misura lo scarto li', si
 * corregge, e si rimisura per il caso in cui la correzione abbia scavalcato il
 * salto.
 *
 * L'ora che NON ESISTE (le 02:30 della notte in cui si va avanti) non e'
 * gestita in modo speciale: restituisce l'istante subito dopo il salto, che e'
 * la lettura ragionevole. Non capita qui, perche' il giornale esce alle otto e
 * il salto italiano sta fra le due e le tre.
 */
export function istanteLocale(
  data: { anno: number; mese: number; giorno: number },
  ora: number,
  minuto: number,
  timezone: string,
): Date {
  const comeSeUtc = Date.UTC(data.anno, data.mese - 1, data.giorno, ora, minuto);
  let istante = new Date(comeSeUtc);
  for (let i = 0; i < 2; i++) {
    istante = new Date(comeSeUtc - scartoMinuti(istante, timezone) * 60000);
  }
  return istante;
}

/** Il giorno locale successivo a quello dato. */
function giornoDopo(d: { anno: number; mese: number; giorno: number }): typeof d {
  // Si passa da UTC di proposito: e' l'aritmetica del CALENDARIO, non del
  // fuso, e qui non c'e' nessuna ora da spostare.
  const x = new Date(Date.UTC(d.anno, d.mese - 1, d.giorno + 1));
  return { anno: x.getUTCFullYear(), mese: x.getUTCMonth() + 1, giorno: x.getUTCDate() };
}

/* ------------------------------------------------------------------ *
 * Le due finestre
 * ------------------------------------------------------------------ */

function istantiOrdinati(calendario: CalendarioGiornata): number[] {
  return calendario.partite
    .map((p) => Date.parse(p.kickoff))
    // Un orario illeggibile e' peggio di un orario assente: si scarta invece
    // di trasformarlo in un NaN che si propaga fino a una data del 1970.
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
}

export type FinestraUscita = {
  /** Da quando si puo' pubblicare. */
  apre: Date;
  /** Fino a quando ha senso pubblicare. `null` = nessun limite. */
  chiude: Date | null;
};

/**
 * LA VIGILIA: la mattina del giorno in cui si comincia, fino al primo fischio.
 *
 * Il limite superiore non e' una cortesia. Un numero di vigilia pubblicato a
 * partite gia' cominciate annuncia come «in programma» una cosa che si sta
 * giocando: e' proprio l'errore che il tipo di edizione esiste per evitare.
 * Meglio saltare un numero che stamparne uno che si contraddice da solo — e il
 * salto deve essere VISIBILE, non silenzioso, per questo chi chiama riceve la
 * finestra e non un booleano.
 */
export function finestraVigilia(
  calendario: CalendarioGiornata,
  opzioni: OpzioniUscite = USCITE_PREDEFINITE,
): FinestraUscita | null {
  const istanti = istantiOrdinati(calendario);
  const primo = istanti[0];
  if (primo === undefined) return null;

  const giorno = oraLocale(new Date(primo), opzioni.timezone);
  const apre = istanteLocale(giorno, opzioni.ora, opzioni.minuto, opzioni.timezone);
  const chiude = new Date(primo);

  /**
   * Una partita alle 08:00 o prima e' un caso che in Serie A non esiste, ma se
   * esistesse la finestra sarebbe rovesciata e `apre > chiude` la renderebbe
   * vuota per sempre. Si apre allora a mezzanotte locale: il numero esce
   * comunque, prima del fischio.
   */
  if (apre.getTime() >= chiude.getTime()) {
    return { apre: istanteLocale(giorno, 0, 0, opzioni.timezone), chiude };
  }
  return { apre, chiude };
}

/**
 * IL RETROSPETTIVO: la mattina dopo l'ultima partita.
 *
 * Nessun limite superiore, e qui e' il contrario della vigilia: una giornata
 * pronta in ritardo — per un posticipo, un rinvio, un guasto del fornitore —
 * si consegna comunque. Un retrospettivo arriva tardi ed e' ancora un
 * giornale; una vigilia in ritardo non e' piu' una vigilia.
 *
 * Questa finestra dice «non prima di». CHI DICE «adesso» RESTA LA MACCHINA A
 * STATI: i voti devono essere stabili. Le due condizioni si sommano, e quella
 * sui dati non e' sostituibile con un orologio.
 */
export function finestraRetrospettivo(
  calendario: CalendarioGiornata,
  opzioni: OpzioniUscite = USCITE_PREDEFINITE,
): FinestraUscita | null {
  const istanti = istantiOrdinati(calendario);
  const ultimo = istanti[istanti.length - 1];
  if (ultimo === undefined) return null;

  const giorno = oraLocale(new Date(ultimo), opzioni.timezone);
  return {
    apre: istanteLocale(giornoDopo(giorno), opzioni.ora, opzioni.minuto, opzioni.timezone),
    chiude: null,
  };
}

export type Uscita = 'vigilia' | 'retrospettivo' | 'nessuna';

export type DecisioneUscita = {
  uscita: Uscita;
  motivo: string;
  /** Fra quanti secondi conviene ricontrollare. Zero quando non c'e' attesa. */
  fraSecondi: number;
};

/**
 * Che numero tocca adesso, secondo il solo orologio.
 *
 * Non guarda i dati e non guarda cosa e' gia' uscito: quelle due domande
 * appartengono a chi chiama, che ha lo store e la macchina a stati. Tenere
 * questa funzione pura — (calendario, adesso) -> decisione — e' cio' che
 * permette di provarla sui giorni di cambio dell'ora senza aspettare ottobre.
 */
export function decidiUscita(
  calendario: CalendarioGiornata,
  adesso: Date,
  opzioni: OpzioniUscite = USCITE_PREDEFINITE,
): DecisioneUscita {
  const vigilia = finestraVigilia(calendario, opzioni);
  const retro = finestraRetrospettivo(calendario, opzioni);

  if (!vigilia || !retro) {
    /**
     * SENZA CALENDARIO NON SI BLOCCA NIENTE.
     *
     * Un orario mancante e' un'informazione che non abbiamo, non un divieto.
     * Se questo caso fermasse le uscite, un fornitore che smette di pubblicare
     * il calendario spegnerebbe il prodotto per tutti senza un errore: il
     * giornale semplicemente non esce piu'. Si lascia decidere alla macchina a
     * stati, che guarda i dati.
     */
    return {
      uscita: 'retrospettivo',
      motivo: 'Nessun calendario per questa giornata: decide la macchina a stati sui dati.',
      fraSecondi: 0,
    };
  }

  const t = adesso.getTime();

  if (t < vigilia.apre.getTime()) {
    return {
      uscita: 'nessuna',
      motivo: `Troppo presto: la vigilia apre ${vigilia.apre.toISOString()}.`,
      fraSecondi: Math.ceil((vigilia.apre.getTime() - t) / 1000),
    };
  }

  if (vigilia.chiude !== null && t < vigilia.chiude.getTime()) {
    return { uscita: 'vigilia', motivo: 'Si comincia a giocare oggi: tocca la vigilia.', fraSecondi: 0 };
  }

  if (t < retro.apre.getTime()) {
    return {
      uscita: 'nessuna',
      motivo: 'Giornata in corso: il retrospettivo esce la mattina dopo l\'ultima partita.',
      fraSecondi: Math.ceil((retro.apre.getTime() - t) / 1000),
    };
  }

  return { uscita: 'retrospettivo', motivo: 'Ultima partita giocata: tocca il retrospettivo.', fraSecondi: 0 };
}
