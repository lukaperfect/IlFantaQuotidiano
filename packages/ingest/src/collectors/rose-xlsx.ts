import type { Role } from '@fantacomics/core';
import { AdapterError } from '../adapter.js';
import type { Righe } from './file-import.js';
import { cella, leggiXlsx, nomeColonna, XlsxError, type Foglio } from '../xlsx.js';

/**
 * IL FILE DELLE ROSE DI leghe.fantacalcio.it.
 *
 * E' il primo formato vero che il prodotto legge, ed e' anche l'artefatto
 * che apre la porta: un admin lo scarica gia' fatto dalla piattaforma, e da
 * quel singolo file escono le squadre della lega, le rose complete, i ruoli e
 * i prezzi d'asta. Non e' una delle cinque tabelle di una giornata — e' cio'
 * che fa ESISTERE la lega, una volta per stagione.
 *
 * Il foglio e' disposto in orizzontale: ogni squadra occupa due colonne
 * affiancate (nome del giocatore, costo) piu' una colonna vuota di stacco,
 * con il nome della squadra in prima riga e una riga «totale» in fondo.
 *
 *   ASD GERANI  costo      Chateau Rouge FC  costo
 *   Vicario        94      Mandas               49
 *   ...
 *   totale       1000      totale              996
 *
 * DUE DIFETTI STRUTTURALI DEL FORMATO, ED E' QUI CHE STA IL LAVORO.
 *
 * 1. Il ruolo non e' scritto da nessuna parte: e' implicito nella POSIZIONE.
 *    I primi tre sono portieri, gli otto dopo difensori, poi otto
 *    centrocampisti, poi sei attaccanti. Una riga aggiunta o tolta a meta'
 *    elenco fa scalare tutti i ruoli sottostanti, e il file resta
 *    perfettamente valido a vedersi. Sarebbe il guasto peggiore possibile:
 *    silenzioso, e capace di sbagliare ogni formazione, ogni XI ottimale e
 *    ogni fatto che ne discende.
 *
 *    Per questo il numero di giocatori non si adatta a cio' che si trova: si
 *    VERIFICA contro il modulo dichiarato, e se non torna il file viene
 *    rifiutato. Dedurre i ruoli da un elenco di lunghezza sbagliata
 *    significherebbe inventarli.
 *
 * 2. Non esiste un identificatore di giocatore: solo il nome visualizzato.
 *    La piattaforma disambigua gli omonimi con le iniziali — «Thuram» e
 *    «Thuram K.» sono due persone diverse, cosi' come «Adams C.» e
 *    «Adams A.». La normalizzazione DEVE tenerli distinti, e siccome un
 *    giocatore in un'asta appartiene a una sola squadra, due chiavi uguali
 *    sono la prova che qualcosa e' andato storto: o una riga duplicata, o due
 *    nomi diversi collassati sulla stessa chiave. In entrambi i casi unirli
 *    in silenzio corromperebbe due rose, quindi si rifiuta.
 *
 * In compenso il formato regala un controllo d'integrita': la riga «totale».
 * Sommare i costi e confrontarli con il totale dichiarato coglie esattamente
 * cio' che il conteggio delle righe non vede — un costo modificato a mano.
 */

/** Quanti giocatori per ruolo, nell'ordine in cui compaiono nella colonna. */
export type LayoutRuoli = readonly (readonly [Role, number])[];

/** Il classico italiano: 3 portieri, 8 difensori, 8 centrocampisti, 6 attaccanti. */
export const LAYOUT_CLASSIC: LayoutRuoli = [['P', 3], ['D', 8], ['C', 8], ['A', 6]];

const NOMI_RUOLO: Record<Role, string> = {
  P: 'portieri', D: 'difensori', C: 'centrocampisti', A: 'attaccanti',
};

/** L'intestazione che marca la colonna dei costi, e con essa l'inizio di un blocco squadra. */
export const INTESTAZIONE_COSTO = 'costo';
const RIGA_TOTALE = 'totale';

/** Tollera il rumore di virgola mobile senza tollerare un credito di differenza. */
const EPSILON = 0.001;

export type GiocatoreRosa = {
  playerId: string;
  playerName: string;
  role: Role;
  purchasePrice: number;
};

export type SquadraRosa = {
  teamId: string;
  teamName: string;
  giocatori: GiocatoreRosa[];
  /** La somma dichiarata dalla riga «totale», se c'era. */
  totaleDichiarato: number | null;
  crediti: number;
};

export type EsitoRose = {
  squadre: SquadraRosa[];
  /**
   * Le stesse rose nella forma di righe piatte: e' il formato che
   * `importFromRecords` gia' consuma dal CSV. Le due sorgenti convergono sugli
   * stessi costruttori invece di somigliarsi finche' qualcuno non le fa
   * divergere.
   */
  righe: Righe;
  /** playerId -> nome e ruolo, dedotti da questo file. */
  anagrafica: Map<string, { playerName: string; role: Role }>;
  diagnostica: {
    foglio: string;
    squadre: number;
    giocatori: number;
    /** Su quante squadre la riga «totale» era presente e combaciava. */
    totaliVerificati: number;
  };
};

/**
 * Nome visualizzato -> chiave stabile.
 *
 * Tiene le iniziali di disambiguazione, che sono l'unica cosa che separa due
 * omonimi: «Thuram» e «Thuram K.» devono restare due chiavi diverse.
 */
export function chiaveGiocatore(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function numero(grezzo: string): number | null {
  const pulito = grezzo.trim().replace(/\s/g, '').replace(',', '.');
  if (pulito === '') return null;
  const n = Number(pulito);
  return Number.isFinite(n) ? n : null;
}

type Blocco = { colNome: number; colCosto: number; teamName: string };

/**
 * Trova i blocchi dal MARCATORE, non dal passo.
 *
 * Il file scaricato mette le squadre ogni tre colonne, ma dedurre il passo da
 * un esempio significa affidare la correttezza a un dettaglio che nessuno ha
 * promesso. La colonna «costo» invece e' semantica: dice cosa c'e' li' dentro.
 */
function trovaBlocchi(foglio: Foglio, rigaIntestazione: number): Blocco[] {
  const blocchi: Blocco[] = [];
  for (let c = 2; c <= foglio.ultimaColonna; c++) {
    const marcatore = cella(foglio, c, rigaIntestazione)?.trim().toLowerCase();
    if (marcatore !== INTESTAZIONE_COSTO) continue;
    const teamName = cella(foglio, c - 1, rigaIntestazione)?.trim();
    if (!teamName) {
      throw new AdapterError(
        `Nel foglio «${foglio.nome}» la colonna ${nomeColonna(c)} e' intitolata «${INTESTAZIONE_COSTO}» ` +
        `ma la colonna ${nomeColonna(c - 1)} accanto non ha il nome della squadra.`,
        'parse', false,
      );
    }
    blocchi.push({ colNome: c - 1, colCosto: c, teamName });
  }
  return blocchi;
}

export type OpzioniRose = {
  /** Quale foglio leggere. Senza nome si prende il primo. */
  foglio?: string;
  layout?: LayoutRuoli;
  /** La riga delle intestazioni. Nel file della piattaforma e' la prima. */
  rigaIntestazione?: number;
};

/** Legge il file e ne ricava le rose. Il punto d'ingresso da un caricamento. */
export function importaRoseXlsx(contenuto: Buffer | Uint8Array, opzioni: OpzioniRose = {}): EsitoRose {
  let fogli;
  try {
    fogli = leggiXlsx(contenuto);
  } catch (e) {
    // Un errore di formato del file e' un errore d'importazione per chi lo ha
    // caricato: deve arrivargli il messaggio, non una schermata di guasto.
    if (e instanceof XlsxError) throw new AdapterError(e.message, 'parse', false);
    throw e;
  }

  const foglio = opzioni.foglio
    ? fogli.find((f) => f.nome.trim().toLowerCase() === opzioni.foglio!.trim().toLowerCase())
    : fogli[0];
  if (!foglio) {
    throw new AdapterError(
      `Il file non contiene un foglio «${opzioni.foglio}». Fogli presenti: ${fogli.map((f) => f.nome).join(', ')}.`,
      'parse', false,
    );
  }
  return leggiRoseDalFoglio(foglio, opzioni);
}

export function leggiRoseDalFoglio(foglio: Foglio, opzioni: OpzioniRose = {}): EsitoRose {
  const layout = opzioni.layout ?? LAYOUT_CLASSIC;
  const rigaIntestazione = opzioni.rigaIntestazione ?? 1;
  const attesi = layout.reduce((a, [, n]) => a + n, 0);
  const descrizioneLayout = layout.map(([r, n]) => `${n} ${NOMI_RUOLO[r]}`).join(', ');

  const blocchi = trovaBlocchi(foglio, rigaIntestazione);
  if (blocchi.length === 0) {
    throw new AdapterError(
      `Nel foglio «${foglio.nome}» non ho trovato nessuna squadra. Mi aspetto, nella riga ` +
      `${rigaIntestazione}, il nome di ogni squadra con accanto una colonna intitolata ` +
      `«${INTESTAZIONE_COSTO}» — come nel file che si scarica dalla lega.`,
      'parse', false,
    );
  }

  const squadre: SquadraRosa[] = [];
  const righe: Righe = [];
  const anagrafica = new Map<string, { playerName: string; role: Role }>();
  const proprietario = new Map<string, string>(); // playerId -> teamName
  const nomePerChiave = new Map<string, string>();
  const idUsati = new Map<string, string>(); // teamId -> teamName
  let totaliVerificati = 0;

  blocchi.forEach((blocco, indice) => {
    const letti: { nome: string; costo: number; riga: number }[] = [];
    let totaleDichiarato: number | null = null;

    for (let r = rigaIntestazione + 1; r <= foglio.ultimaRiga; r++) {
      const grezzo = cella(foglio, blocco.colNome, r)?.trim();
      if (!grezzo) continue; // una riga vuota di stacco non chiude il blocco
      if (grezzo.toLowerCase() === RIGA_TOTALE) {
        totaleDichiarato = numero(cella(foglio, blocco.colCosto, r) ?? '');
        break;
      }
      const costo = numero(cella(foglio, blocco.colCosto, r) ?? '');
      if (costo === null) {
        throw new AdapterError(
          `«${blocco.teamName}»: il costo di «${grezzo}» (cella ${nomeColonna(blocco.colCosto)}${r}) ` +
          `non e' un numero.`,
          'parse', false,
        );
      }
      if (costo < 0) {
        throw new AdapterError(
          `«${blocco.teamName}»: il costo di «${grezzo}» e' negativo (${costo}).`, 'parse', false,
        );
      }
      letti.push({ nome: grezzo, costo, riga: r });
    }

    // 1. Il conteggio. Senza questo i ruoli scalerebbero in silenzio.
    if (letti.length !== attesi) {
      throw new AdapterError(
        `«${blocco.teamName}» ha ${letti.length} giocatori invece di ${attesi} ` +
        `(${descrizioneLayout}). Il ruolo di ogni giocatore viene dalla sua posizione ` +
        `nell'elenco, quindi con un numero di righe diverso assegnerei il ruolo sbagliato ` +
        `a tutti quelli sotto. Controlla la colonna ${nomeColonna(blocco.colNome)}.`,
        'parse', false,
      );
    }

    // 2. Il checksum. Coglie cio' che il conteggio non vede: un costo corretto a mano.
    const somma = letti.reduce((a, g) => a + g.costo, 0);
    if (totaleDichiarato !== null) {
      if (Math.abs(somma - totaleDichiarato) > EPSILON) {
        throw new AdapterError(
          `«${blocco.teamName}»: i costi sommano ${somma} ma la riga «${RIGA_TOTALE}» dice ` +
          `${totaleDichiarato}. Il file non torna con se stesso: controlla i costi di quella colonna.`,
          'parse', false,
        );
      }
      totaliVerificati++;
    }

    let teamId = chiaveGiocatore(blocco.teamName) || `squadra-${indice + 1}`;
    const gemella = idUsati.get(teamId);
    if (gemella !== undefined) {
      throw new AdapterError(
        `Due squadre si chiamano allo stesso modo: «${gemella}» e «${blocco.teamName}». ` +
        `Servono nomi distinguibili.`,
        'parse', false,
      );
    }
    idUsati.set(teamId, blocco.teamName);

    // 3. I ruoli, per posizione, sul numero di righe appena verificato.
    const giocatori: GiocatoreRosa[] = [];
    let k = 0;
    for (const [role, quanti] of layout) {
      for (let j = 0; j < quanti; j++, k++) {
        const g = letti[k]!;
        const playerId = chiaveGiocatore(g.nome);
        if (playerId === '') {
          throw new AdapterError(
            `«${blocco.teamName}»: il nome nella cella ${nomeColonna(blocco.colNome)}${g.riga} ` +
            `(«${g.nome}») non contiene lettere o numeri.`,
            'parse', false,
          );
        }

        const altrove = proprietario.get(playerId);
        if (altrove !== undefined) {
          const nomeAltrove = nomePerChiave.get(playerId)!;
          throw new AdapterError(
            nomeAltrove === g.nome
              ? `«${g.nome}» compare sia in «${altrove}» sia in «${blocco.teamName}». ` +
                `In un'asta ogni giocatore appartiene a una squadra sola.`
              : `«${nomeAltrove}» (${altrove}) e «${g.nome}» (${blocco.teamName}) finiscono sullo ` +
                `stesso identificatore «${playerId}». Sono due giocatori diversi e vanno distinti nel file.`,
            'parse', false,
          );
        }
        proprietario.set(playerId, blocco.teamName);
        nomePerChiave.set(playerId, g.nome);

        giocatori.push({ playerId, playerName: g.nome, role, purchasePrice: g.costo });
        anagrafica.set(playerId, { playerName: g.nome, role });
        righe.push({
          teamId,
          teamName: blocco.teamName,
          playerId,
          playerName: g.nome,
          role,
          purchasePrice: String(g.costo),
        });
      }
    }

    squadre.push({
      teamId, teamName: blocco.teamName, giocatori, totaleDichiarato, crediti: somma,
    });
  });

  return {
    squadre,
    righe,
    anagrafica,
    diagnostica: {
      foglio: foglio.nome,
      squadre: squadre.length,
      giocatori: squadre.reduce((a, s) => a + s.giocatori.length, 0),
      totaliVerificati,
    },
  };
}
