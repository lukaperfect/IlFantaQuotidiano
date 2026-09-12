import type {
  EntityRef, FactPack, FactType, LeagueRoster, NarrativeFact, Role, RosterPlayer,
} from '@fantacomics/core';
import { fmt, safeName } from '@fantacomics/core';
import { drama, intensityOf } from './drama.js';
import { toFact, type FactDraft, type LeagueHistory } from './context.js';

/**
 * I FATTI CHE ESISTONO PRIMA CHE SI GIOCHI.
 *
 * Tutto il resto del motore parte da un risultato. Questo no: gira la mattina
 * in cui le partite non sono ancora cominciate, e il caso che lo governa e' il
 * piu' povero di tutti — la primissima edizione di una lega appena iscritta,
 * dove l'unico dato al mondo e' il file delle rose caricato mezz'ora prima.
 *
 * E' anche il caso che conta di piu' commercialmente: e' la prima pagina che
 * un cliente pagante vede. Se la si lascia dipendere dallo storico, il primo
 * numero esce vuoto proprio al cliente appena acquisito.
 *
 * LA COSA CHE SALVA QUELLA PAGINA E' L'ASTA. Un'asta e' gia' una storia
 * completa: c'e' chi ha buttato mezzo budget su un attaccante, chi ha comprato
 * il portiere a un credito, chi ha spalmato tutto in venticinque mediocrita'.
 * Sono fatti verificati, non congetture: il file li porta con la riga `totale`
 * che ne fa da somma di controllo.
 *
 * CIO' CHE QUI NON C'E', DI PROPOSITO. «Chi non ha ancora giustificato quello
 * che e' costato» sarebbe il fatto piu' divertente della famiglia, e chiede i
 * punti per GIOCATORE nelle giornate passate. Lo storico di lega conserva i
 * punti per squadra, non per giocatore: il fatto non e' calcolabile, e
 * ricavarlo «per approssimazione» significherebbe stampare un numero inventato
 * nel gruppo WhatsApp di dieci persone che conoscono le loro rose a memoria.
 * Resta fuori finche' il dato non esiste.
 */

/**
 * Versione del motore dei fatti d'anteprima, distinta da quella del
 * retrospettivo: sono due motori, e un'edizione salvata deve dire quale l'ha
 * prodotta. Un «1.0.0» ambiguo fra i due non permetterebbe di rileggere fra sei
 * mesi con che cosa e' stato fatto un numero.
 */
export const ANTEPRIMA_ENGINE_VERSION = 'anteprima-1.0.0';

export type SfidaInProgramma = { homeTeamId: string; awayTeamId: string };

export type AnteprimaInput = {
  roster: LeagueRoster;
  /** La giornata che si sta per giocare. */
  matchday: number;
  /** Gli accoppiamenti in programma: dal calendario di lega. */
  fixtures: readonly SfidaInProgramma[];
  /** Le giornate GIA' giocate. Vuoto alla prima: e' il caso normale, non un errore. */
  history?: LeagueHistory;
};

/** Una riga di classifica ricostruita dallo storico. */
export type RigaClassifica = {
  teamId: string;
  position: number;
  leaguePoints: number;
  fantasyPoints: number;
};

export type AnteprimaOutput = {
  facts: NarrativeFact[];
  standings: RigaClassifica[];
  /** Quante squadre il file delle rose descrive: serve alle asserzioni di copertura. */
  teamCount: number;
};

/* ------------------------------------------------------------------ *
 * Aggregati per squadra: si calcolano una volta e li leggono tutti.
 * ------------------------------------------------------------------ */

type ContoSquadra = {
  teamId: string;
  /** Sanitizzato: arriva da un file caricato da un utente. */
  teamName: string;
  players: readonly RosterPlayer[];
  speso: number;
  perRuolo: Record<Role, number>;
  quantiPerRuolo: Record<Role, number>;
  piuCaro: RosterPlayer | null;
  /** Quota del piu' caro sulla spesa totale, 0..1. */
  quotaPiuCaro: number;
};

const RUOLI: Role[] = ['P', 'D', 'C', 'A'];

function contiDelleSquadre(roster: LeagueRoster): ContoSquadra[] {
  return roster.teams.map((t) => {
    const perRuolo: Record<Role, number> = { P: 0, D: 0, C: 0, A: 0 };
    const quantiPerRuolo: Record<Role, number> = { P: 0, D: 0, C: 0, A: 0 };
    let speso = 0;
    let piuCaro: RosterPlayer | null = null;

    for (const g of t.players) {
      speso += g.purchasePrice;
      perRuolo[g.role] += g.purchasePrice;
      quantiPerRuolo[g.role] += 1;
      /**
       * A parita' di prezzo vince il playerId minore, non il primo incontrato:
       * l'ordine delle righe di un foglio non e' una garanzia, e un fatto che
       * cambia se l'admin riordina le righe non e' riproducibile.
       */
      if (
        piuCaro === null
        || g.purchasePrice > piuCaro.purchasePrice
        || (g.purchasePrice === piuCaro.purchasePrice && g.playerId < piuCaro.playerId)
      ) piuCaro = g;
    }

    return {
      teamId: t.teamId,
      teamName: safeName(t.teamName),
      players: t.players,
      speso,
      perRuolo,
      quantiPerRuolo,
      piuCaro,
      quotaPiuCaro: speso > 0 && piuCaro ? piuCaro.purchasePrice / speso : 0,
    };
  });
}

function teamRefDi(c: ContoSquadra): EntityRef {
  return { kind: 'team', id: c.teamId, display: c.teamName };
}

function playerRefDi(g: RosterPlayer): EntityRef {
  return { kind: 'player', id: g.playerId, display: safeName(g.playerName, 32) };
}

function percento(quota: number): string {
  return `${Math.round(quota * 100)}%`;
}

/**
 * IL SUPERLATIVO DEVE ESSERE VERO.
 *
 * «Il piu' pagato della lega» con due giocatori a pari prezzo e' una frase
 * falsa, e il giornale la stampa in prima pagina davanti a dieci persone che
 * possono controllare. Questa funzione restituisce l'estremo SOLO quando e'
 * separato dal secondo di un margine reale; in caso di parita' il fatto non
 * viene emesso affatto, che e' la risposta giusta: la copertura la garantiscono
 * i fatti per squadra, non i superlativi.
 *
 * `margine` esiste perche' su valori continui (le quote) la separazione
 * matematica non basta: 41,2% contro 41,1% non e' una notizia, e' rumore.
 */
function estremo<T>(
  elementi: readonly T[],
  valore: (x: T) => number,
  verso: 'max' | 'min',
  margine = 0,
): T | null {
  const ordinati = [...elementi].sort((a, b) => (verso === 'max'
    ? valore(b) - valore(a)
    : valore(a) - valore(b)));
  const primo = ordinati[0];
  if (primo === undefined) return null;

  /**
   * UN SOLO CANDIDATO E' UN ESTREMO VALIDO.
   *
   * Qui pretendevo almeno due elementi, ragionando sui superlativi d'asta dove
   * la popolazione e' fissa (tutte le squadre) e un secondo esiste sempre. Ma
   * questa funzione serve anche alle strisce, dove la popolazione e' «chi si
   * qualifica»: con UNA sola squadra a tre vittorie di fila — il caso piu'
   * comune di tutti — non c'era nessun secondo, e la striscia non veniva
   * raccontata mai. Senza un secondo non esiste parita', quindi il superlativo
   * e' vero per definizione.
   */
  const secondo = ordinati[1];
  if (secondo === undefined) return primo;

  const scarto = Math.abs(valore(primo) - valore(secondo));
  return scarto > margine ? primo : null;
}

/* ------------------------------------------------------------------ *
 * La classifica ricostruita dallo storico.
 * ------------------------------------------------------------------ */

/**
 * Classifica PRIMA della giornata in programma, dalle giornate giocate.
 *
 * La posizione la si prende da `positions` dell'ultima giornata quando c'e',
 * perche' e' quella che i lettori vedono sulla piattaforma: ricalcolarla
 * significherebbe reinventarne i criteri di parita' e rischiare di pubblicare
 * una classifica che non coincide con la loro. Si deriva solo quando manca.
 */
export function classificaDaStorico(
  teamIds: readonly string[],
  history: LeagueHistory,
): RigaClassifica[] {
  /**
   * A ZERO GIORNATE GIOCATE NON ESISTE UNA CLASSIFICA, e restituirne una a
   * punti zero non e' un caso limite gestito: e' un dato inventato. Ordinata
   * per forza di cose in un ordine qualsiasi — quello del file — dichiarerebbe
   * che una squadra e' prima e un'altra decima prima che si sia giocato un
   * minuto. Misurato sul file vero: dieci righe, «1° ASD GERANI, 0 punti».
   * Vuota, il giornale semplicemente non la stampa.
   */
  if (history.entries.length === 0) return [];

  const leaguePoints = new Map<string, number>(teamIds.map((id) => [id, 0]));
  const fantasyPoints = new Map<string, number>(teamIds.map((id) => [id, 0]));

  for (const e of history.entries) {
    for (const id of teamIds) {
      const esito = e.results[id];
      if (esito === 'W') leaguePoints.set(id, (leaguePoints.get(id) ?? 0) + 3);
      else if (esito === 'D') leaguePoints.set(id, (leaguePoints.get(id) ?? 0) + 1);
      fantasyPoints.set(id, (fantasyPoints.get(id) ?? 0) + (e.points[id] ?? 0));
    }
  }

  const ultima = history.entries[history.entries.length - 1];
  const righe = teamIds.map((id) => ({
    teamId: id,
    leaguePoints: leaguePoints.get(id) ?? 0,
    fantasyPoints: Math.round((fantasyPoints.get(id) ?? 0) * 100) / 100,
    dichiarata: ultima?.positions[id],
  }));

  righe.sort((a, b) => {
    if (a.dichiarata !== undefined && b.dichiarata !== undefined) return a.dichiarata - b.dichiarata;
    return b.leaguePoints - a.leaguePoints
      || b.fantasyPoints - a.fantasyPoints
      || a.teamId.localeCompare(b.teamId);
  });

  return righe.map((r, i) => ({
    teamId: r.teamId,
    position: r.dichiarata ?? i + 1,
    leaguePoints: r.leaguePoints,
    fantasyPoints: r.fantasyPoints,
  }));
}

/** Quante vittorie (o sconfitte) consecutive chiude lo storico per questa squadra. */
function striscia(history: LeagueHistory, teamId: string, esito: 'W' | 'L'): number {
  let n = 0;
  for (let i = history.entries.length - 1; i >= 0; i--) {
    if (history.entries[i]?.results[teamId] === esito) n += 1;
    else break;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * I fatti.
 * ------------------------------------------------------------------ */

/** Il peso di ciascun tipo: la stessa scala del motore retrospettivo. */
const PESI: Partial<Record<FactType, number>> = {
  RE_DELL_ASTA: 84,
  ASTA_AL_RISPARMIO: 62,
  ATTACCO_PIU_COSTOSO: 66,
  PORTA_LOW_COST: 58,
  ASTA_SPALMATA: 54,
  PEZZO_PREGIATO: 34,
  SFIDA_IN_PROGRAMMA: 30,
  SCONTRO_AL_VERTICE: 76,
  SCONTRO_DI_CODA: 64,
  CONTI_APERTI: 70,
  STRISCIA_APERTA: 72,
  CRISI_APERTA: 74,
};

function peso(tipo: FactType): number {
  return PESI[tipo] ?? 40;
}

/**
 * QUANTO VALE ANCORA L'ASTA, DOPO CHE SI E' COMINCIATO A GIOCARE.
 *
 * I fatti d'asta hanno un difetto che nessun altro fatto del prodotto ha: sono
 * gli STESSI OGNI SETTIMANA. Martinez L. e' costato 460 crediti alla prima
 * giornata e gli stessi 460 alla trentesima. Con due uscite a settimana per
 * trentotto giornate, lasciarli a peso pieno significa che dalla terza vigilia
 * il giornale ripete se stesso — ed e' il rischio numero uno del prodotto, non
 * l'allucinazione: la noia.
 *
 * Il cooldown sul tipo di fatto da solo non basta: smorza per quattro giornate
 * e poi il fatto torna identico, stesso numero e stessa frase.
 *
 * Quindi decadono. Alla vigilia della prima giornata l'asta E' la notizia,
 * perche' non esiste altro; a stagione avviata la notizia e' chi arriva con
 * quattro vittorie di fila, e «chi ha pagato 460 in agosto» e' un trafiletto.
 * La copertura di tutte le squadre non si perde: da quando c'e' un calendario
 * la garantiscono gli accoppiamenti, che sono diversi ogni settimana.
 */
function decadimentoAsta(giornateGiocate: number): number {
  return 1 / (1 + giornateGiocate / 2);
}

/** I fatti che nascono dalle sole rose: disponibili dal primo giorno. */
function fattiDAsta(conti: readonly ContoSquadra[], decadimento: number): FactDraft[] {
  const drafts: FactDraft[] = [];

  /**
   * IL RE DELL'ASTA: il giocatore piu' pagato di tutta la lega.
   *
   * Si cerca fra i giocatori, non fra le squadre, e si tiene la coppia
   * (squadra, giocatore) — la notizia e' chi lo ha comprato tanto quanto
   * quanto e' costato.
   */
  const tutti = conti.flatMap((c) => c.players.map((g) => ({ c, g })));
  const re = estremo(tutti, (x) => x.g.purchasePrice, 'max');
  if (re) {
    const quota = re.c.speso > 0 ? re.g.purchasePrice / re.c.speso : 0;
    drafts.push({
      type: 'RE_DELL_ASTA',
      subjects: [teamRefDi(re.c), playerRefDi(re.g)],
      numbers: {
        prezzo: fmt(re.g.purchasePrice, 0),
        quota: percento(quota),
        spesa_totale: fmt(re.c.speso, 0),
      },
      polarity: 'trionfo',
      drama: decadimento * drama(peso('RE_DELL_ASTA'), { intensity: intensityOf(quota, 0.5) }),
      plain: `${re.g.playerName} e' il piu' pagato della lega: ${fmt(re.g.purchasePrice, 0)} `
        + `crediti, il ${percento(quota)} di quanto ${re.c.teamName} ha speso in tutto.`,
      evidence: [{ source: 'rose', detail: 'prezzo di acquisto all\'asta' }],
    });
  }

  /** Chi ha speso meno di tutti, e di quanto. Mai «crediti risparmiati»: il
   * budget non sta nel file, e dedurlo sarebbe inventarlo. */
  const massimo = Math.max(...conti.map((c) => c.speso));
  const parsimonioso = estremo(conti, (c) => c.speso, 'min', 0.02 * massimo);
  if (parsimonioso) {
    const scarto = massimo - parsimonioso.speso;
    drafts.push({
      type: 'ASTA_AL_RISPARMIO',
      subjects: [teamRefDi(parsimonioso)],
      numbers: {
        spesa: fmt(parsimonioso.speso, 0),
        scarto: fmt(scarto, 0),
        spesa_massima: fmt(massimo, 0),
      },
      polarity: 'mediocrita',
      drama: decadimento * drama(peso('ASTA_AL_RISPARMIO'), { intensity: intensityOf(scarto / massimo, 0.2) }),
      plain: `${parsimonioso.teamName} e' la squadra che ha speso meno all'asta: `
        + `${fmt(parsimonioso.speso, 0)} crediti, ${fmt(scarto, 0)} in meno di chi ha speso di piu'.`,
      evidence: [{ source: 'rose', detail: 'somma dei prezzi di acquisto' }],
    });
  }

  /** Chi ha messo piu' crediti in attacco. */
  const attacco = estremo(conti, (c) => c.perRuolo.A, 'max');
  if (attacco) {
    const quota = attacco.speso > 0 ? attacco.perRuolo.A / attacco.speso : 0;
    drafts.push({
      type: 'ATTACCO_PIU_COSTOSO',
      subjects: [teamRefDi(attacco)],
      numbers: {
        spesa_attacco: fmt(attacco.perRuolo.A, 0),
        quota: percento(quota),
        attaccanti: String(attacco.quantiPerRuolo.A),
        spesa_totale: fmt(attacco.speso, 0),
      },
      polarity: 'trionfo',
      drama: decadimento * drama(peso('ATTACCO_PIU_COSTOSO'), { intensity: intensityOf(quota, 0.6) }),
      plain: `${attacco.teamName} ha l'attacco piu' caro della lega: `
        + `${fmt(attacco.perRuolo.A, 0)} crediti per ${attacco.quantiPerRuolo.A} attaccanti, `
        + `il ${percento(quota)} della sua spesa.`,
      evidence: [{ source: 'rose', detail: 'prezzi dei giocatori di ruolo A' }],
    });
  }

  /** Chi ha speso meno fra i pali. Il portiere da un credito e' un classico. */
  const porta = estremo(conti, (c) => c.perRuolo.P, 'min');
  if (porta) {
    drafts.push({
      type: 'PORTA_LOW_COST',
      subjects: [teamRefDi(porta)],
      numbers: {
        spesa_porta: fmt(porta.perRuolo.P, 0),
        portieri: String(porta.quantiPerRuolo.P),
        spesa_totale: fmt(porta.speso, 0),
      },
      polarity: 'farsa',
      drama: decadimento * drama(peso('PORTA_LOW_COST'), {
        intensity: 1 - intensityOf(porta.perRuolo.P, Math.max(1, 0.1 * porta.speso)),
      }),
      plain: `${porta.teamName} ha la porta piu' economica della lega: `
        + `${fmt(porta.perRuolo.P, 0)} crediti per ${porta.quantiPerRuolo.P} portieri.`,
      evidence: [{ source: 'rose', detail: 'prezzi dei giocatori di ruolo P' }],
    });
  }

  /**
   * L'ASTA SPALMATA: la rosa in cui nessuno spicca.
   *
   * Si misura con la quota del piu' caro sulla spesa: chi ha la quota piu'
   * bassa ha comprato venticinque giocatori equivalenti. Il margine di mezzo
   * punto percentuale serve perche' su valori continui due squadre a 11,2% e
   * 11,1% non sono una notizia.
   */
  const spalmata = estremo(conti, (c) => c.quotaPiuCaro, 'min', 0.005);
  if (spalmata && spalmata.piuCaro) {
    drafts.push({
      type: 'ASTA_SPALMATA',
      subjects: [teamRefDi(spalmata), playerRefDi(spalmata.piuCaro)],
      numbers: {
        quota_piu_caro: percento(spalmata.quotaPiuCaro),
        prezzo_piu_caro: fmt(spalmata.piuCaro.purchasePrice, 0),
        spesa_totale: fmt(spalmata.speso, 0),
      },
      polarity: 'mediocrita',
      drama: decadimento * drama(peso('ASTA_SPALMATA'), { intensity: 1 - intensityOf(spalmata.quotaPiuCaro, 0.3) }),
      plain: `${spalmata.teamName} ha spalmato l'asta: il suo giocatore piu' pagato, `
        + `${spalmata.piuCaro.playerName}, vale solo il ${percento(spalmata.quotaPiuCaro)} `
        + 'della spesa.',
      evidence: [{ source: 'rose', detail: 'rapporto fra il prezzo massimo e la spesa totale' }],
    });
  }

  return drafts;
}

/**
 * IL PEZZO PREGIATO, UNO PER SQUADRA.
 *
 * Non e' un superlativo di lega: e' il fatto che garantisce la COPERTURA.
 * I cinque fatti d'asta qui sopra nominano al massimo cinque squadre, e in una
 * lega da dieci significa che la metà dei paganti non compare da nessuna parte
 * del proprio giornale — il difetto che il selettore combatte con il bonus di
 * copertura e che qui si evita alla radice. Peso basso di proposito: deve
 * riempire le rubriche, non prendersi l'apertura.
 *
 * SALTA LE SQUADRE DI CUI UN SUPERLATIVO GIA' RACCONTA IL GIOCATORE PIU' CARO.
 * Sono RE_DELL_ASTA e ASTA_SPALMATA: entrambi parlano, con parole diverse,
 * esattamente del pezzo pregiato di quella rosa. Misurato sul file vero,
 * senza questo filtro Chateau Rouge FC compariva due volte con lo stesso
 * giocatore e la stessa percentuale — «Soule' vale solo il 14% della spesa» e
 * «il colpo d'asta e' Soule', 140 crediti su 996». Due pezzi cosi' nello
 * stesso numero sono il difetto che la guardia anti-ripetizione esiste per
 * cogliere, e farglielo trovare nei MIEI dati e' arrivare tardi.
 *
 * ATTACCO_PIU_COSTOSO, PORTA_LOW_COST e ASTA_AL_RISPARMIO invece no: parlano
 * di aggregati diversi e convivono senza ripetersi. InterMaxMiami ha l'attacco
 * piu' caro (690 su sei attaccanti) E il suo colpo d'asta (Malen, 433): sono
 * due notizie.
 */
function fattiPerSquadra(
  conti: readonly ContoSquadra[],
  giaRaccontate: ReadonlySet<string>,
  decadimento: number,
): FactDraft[] {
  const drafts: FactDraft[] = [];
  for (const c of conti) {
    if (giaRaccontate.has(c.teamId) || c.piuCaro === null) continue;
    drafts.push({
      type: 'PEZZO_PREGIATO',
      subjects: [teamRefDi(c), playerRefDi(c.piuCaro)],
      numbers: {
        prezzo: fmt(c.piuCaro.purchasePrice, 0),
        quota: percento(c.quotaPiuCaro),
        spesa_totale: fmt(c.speso, 0),
      },
      polarity: 'mediocrita',
      drama: decadimento * drama(peso('PEZZO_PREGIATO'), { intensity: intensityOf(c.quotaPiuCaro, 0.4) }),
      plain: `Il colpo d'asta di ${c.teamName} e' ${c.piuCaro.playerName}, pagato `
        + `${fmt(c.piuCaro.purchasePrice, 0)} crediti su ${fmt(c.speso, 0)} di spesa.`,
      evidence: [{ source: 'rose', detail: "giocatore piu' caro della rosa" }],
    });
  }
  return drafts;
}

/** I fatti che nascono dal calendario e, quando c'e', dallo storico. */
function fattiDelleSfide(
  conti: readonly ContoSquadra[],
  fixtures: readonly SfidaInProgramma[],
  classifica: readonly RigaClassifica[],
  history: LeagueHistory,
): FactDraft[] {
  const perId = new Map(conti.map((c) => [c.teamId, c]));
  const posizione = new Map(classifica.map((r) => [r.teamId, r]));
  const quante = classifica.length;
  const drafts: FactDraft[] = [];

  for (const f of fixtures) {
    const casa = perId.get(f.homeTeamId);
    const ospite = perId.get(f.awayTeamId);
    // Una sfida che nomina una squadra fuori dalle rose non e' raccontabile:
    // non se ne conosce il nome, e stamparne l'id sarebbe peggio di tacere.
    if (!casa || !ospite) continue;

    const soggetti = [teamRefDi(casa), teamRefDi(ospite)];
    const scartoSpesa = Math.abs(casa.speso - ospite.speso);

    drafts.push({
      type: 'SFIDA_IN_PROGRAMMA',
      subjects: soggetti,
      numbers: {
        spesa_casa: fmt(casa.speso, 0),
        spesa_ospite: fmt(ospite.speso, 0),
        scarto_spesa: fmt(scartoSpesa, 0),
      },
      polarity: 'mediocrita',
      drama: drama(peso('SFIDA_IN_PROGRAMMA'), {
        intensity: intensityOf(scartoSpesa / Math.max(1, casa.speso), 0.2),
      }),
      plain: `${casa.teamName} contro ${ospite.teamName}: all'asta hanno speso `
        + `${fmt(casa.speso, 0)} e ${fmt(ospite.speso, 0)} crediti.`,
      evidence: [{ source: 'calendario', detail: 'accoppiamento della giornata' }],
    });

    const rigaCasa = posizione.get(f.homeTeamId);
    const rigaOspite = posizione.get(f.awayTeamId);
    if (!rigaCasa || !rigaOspite || history.entries.length === 0) continue;

    const numeriClassifica = {
      posizione_casa: `${rigaCasa.position}°`,
      posizione_ospite: `${rigaOspite.position}°`,
      punti_casa: String(rigaCasa.leaguePoints),
      punti_ospite: String(rigaOspite.leaguePoints),
    };

    /** Lo scontro al vertice: entrambe nel primo terzo, massimo tre squadre. */
    const soglia = Math.max(2, Math.min(3, Math.floor(quante / 3)));
    if (rigaCasa.position <= soglia && rigaOspite.position <= soglia) {
      drafts.push({
        type: 'SCONTRO_AL_VERTICE',
        subjects: soggetti,
        numbers: numeriClassifica,
        polarity: 'trionfo',
        drama: drama(peso('SCONTRO_AL_VERTICE'), {
          intensity: 1 - intensityOf(rigaCasa.position + rigaOspite.position, 2 * soglia + 2),
        }),
        plain: `${casa.teamName} (${rigaCasa.position}°, ${rigaCasa.leaguePoints} punti) `
          + `affronta ${ospite.teamName} (${rigaOspite.position}°, ${rigaOspite.leaguePoints} punti).`,
        evidence: [{ source: 'classifica', detail: 'posizioni prima della giornata' }],
      });
    }

    if (rigaCasa.position > quante - soglia && rigaOspite.position > quante - soglia) {
      drafts.push({
        type: 'SCONTRO_DI_CODA',
        subjects: soggetti,
        numbers: numeriClassifica,
        polarity: 'farsa',
        drama: drama(peso('SCONTRO_DI_CODA'), {
          intensity: intensityOf(rigaCasa.position + rigaOspite.position, 2 * quante),
        }),
        plain: `${casa.teamName} (${rigaCasa.position}°) e ${ospite.teamName} `
          + `(${rigaOspite.position}°) si incontrano in fondo alla classifica.`,
        evidence: [{ source: 'classifica', detail: 'posizioni prima della giornata' }],
      });
    }

    /** I conti aperti: si sono gia' incontrate in questa stagione. */
    const precedenti = history.entries.filter((e) => e.opponents[f.homeTeamId] === f.awayTeamId);
    if (precedenti.length > 0) {
      let vinteCasa = 0;
      let vinteOspite = 0;
      let pari = 0;
      for (const e of precedenti) {
        const esito = e.results[f.homeTeamId];
        if (esito === 'W') vinteCasa += 1;
        else if (esito === 'L') vinteOspite += 1;
        else pari += 1;
      }
      const dominio = Math.abs(vinteCasa - vinteOspite);
      drafts.push({
        type: 'CONTI_APERTI',
        subjects: soggetti,
        numbers: {
          incontri: String(precedenti.length),
          vittorie_casa: String(vinteCasa),
          vittorie_ospite: String(vinteOspite),
          pareggi: String(pari),
        },
        polarity: dominio > 0 ? 'trionfo' : 'farsa',
        drama: drama(peso('CONTI_APERTI'), {
          intensity: intensityOf(dominio, Math.max(1, precedenti.length)),
        }),
        plain: `${casa.teamName} e ${ospite.teamName} si sono gia' incontrate `
          + `${precedenti.length} volte quest'anno: ${vinteCasa} vittorie della prima, `
          + `${vinteOspite} della seconda, ${pari} pareggi.`,
        evidence: [{ source: 'storico', detail: 'giornate precedenti della stagione' }],
      });
    }
  }

  return drafts;
}

/**
 * Strisce e crisi in corso: chi arriva alla giornata lanciato o a pezzi.
 *
 * UNA SOLA STRISCIA E UNA SOLA CRISI, non una per squadra.
 *
 * Emetterli per ogni squadra qualificata sembrava piu' completo ed era il
 * difetto: in una lega da dieci squadre capita benissimo che tre arrivino con
 * tre sconfitte di fila, e ne uscivano tre fatti identici a meno del nome —
 * «X arriva con 3 sconfitte di fila» per tre volte. Misurato su uno storico di
 * prova, la guardia anti-ripetizione scattava su due pezzi e la confidenza
 * dell'edizione scendeva a 0,70 contro una soglia di pubblicazione a 0,60.
 *
 * Un giornale racconta LA striscia piu' lunga, non fa l'elenco. La copertura
 * delle altre squadre non si perde: da quando c'e' un calendario ogni squadra
 * compare nel proprio accoppiamento.
 */
function fattiDelleStrisce(
  conti: readonly ContoSquadra[],
  history: LeagueHistory,
): FactDraft[] {
  const drafts: FactDraft[] = [];
  const MINIMO = 3;

  const candidati = (esito: 'W' | 'L') => conti
    .map((c) => ({ c, quante: striscia(history, c.teamId, esito) }))
    .filter((x) => x.quante >= MINIMO);

  // Lo stesso criterio dei superlativi d'asta: se due squadre sono a pari
  // striscia, «la piu' lunga» e' una frase falsa e il fatto non si emette.
  const lanciata = estremo(candidati('W'), (x) => x.quante, 'max');
  if (lanciata) {
    drafts.push({
      type: 'STRISCIA_APERTA',
      subjects: [teamRefDi(lanciata.c)],
      numbers: { vittorie: String(lanciata.quante) },
      polarity: 'trionfo',
      drama: drama(peso('STRISCIA_APERTA'), { intensity: intensityOf(lanciata.quante, 6) }),
      plain: `${lanciata.c.teamName} arriva a questa giornata con ${lanciata.quante} `
        + 'vittorie di fila, la striscia aperta piu\' lunga della lega.',
      evidence: [{ source: 'storico', detail: 'esiti consecutivi' }],
    });
  }

  const affondata = estremo(candidati('L'), (x) => x.quante, 'max');
  if (affondata) {
    drafts.push({
      type: 'CRISI_APERTA',
      subjects: [teamRefDi(affondata.c)],
      numbers: { sconfitte: String(affondata.quante) },
      polarity: 'tragedia',
      drama: drama(peso('CRISI_APERTA'), { intensity: intensityOf(affondata.quante, 6) }),
      plain: `${affondata.c.teamName} arriva a questa giornata con ${affondata.quante} `
        + 'sconfitte di fila, la serie negativa piu\' lunga della lega.',
      evidence: [{ source: 'storico', detail: 'esiti consecutivi' }],
    });
  }

  return drafts;
}

/**
 * Funzione PURA, come il motore retrospettivo: (rose, calendario, storico) ->
 * fatti. Nessun I/O, nessuna data corrente, nessun caso non deterministico.
 */
export function generateAnteprimaFacts(input: AnteprimaInput): AnteprimaOutput {
  const conti = contiDelleSquadre(input.roster);
  const history = input.history ?? { entries: [] };
  const classifica = classificaDaStorico(conti.map((c) => c.teamId), history);

  /**
   * Il decadimento si calcola UNA volta dalle giornate effettivamente giocate,
   * non dal numero della giornata: una lega che si iscrive alla dodicesima
   * giornata ha uno storico vuoto, e per lei l'asta e' notizia fresca.
   */
  const decadimento = decadimentoAsta(history.entries.length);
  const asta = fattiDAsta(conti, decadimento);
  /** I tipi che raccontano il giocatore piu' caro di una rosa: vedi sotto. */
  const SUL_PIU_CARO: readonly FactType[] = ['RE_DELL_ASTA', 'ASTA_SPALMATA'];
  const giaRaccontate = new Set(
    asta
      .filter((d) => SUL_PIU_CARO.includes(d.type))
      .flatMap((d) => d.subjects.filter((x) => x.kind === 'team').map((x) => x.id)),
  );

  const drafts = [
    ...asta,
    ...fattiPerSquadra(conti, giaRaccontate, decadimento),
    ...fattiDelleSfide(conti, input.fixtures, classifica, history),
    ...fattiDelleStrisce(conti, history),
  ];

  const byId = new Map<string, NarrativeFact>();
  for (const draft of drafts) {
    const fact = toFact(input.matchday, draft);
    const existing = byId.get(fact.id);
    if (!existing || fact.drama > existing.drama) byId.set(fact.id, fact);
  }

  const facts = [...byId.values()].sort((a, b) => b.drama - a.drama || a.id.localeCompare(b.id));
  return { facts, standings: classifica, teamCount: conti.length };
}

/** Il pacchetto dell'anteprima: gli stessi campi, `fixtures` invece di `results`. */
export function buildAnteprimaPack(
  input: AnteprimaInput,
  output: AnteprimaOutput,
  meta: { leagueId: string; leagueName: string; factEngineVersion: string },
): FactPack {
  const nomi = new Map(input.roster.teams.map((t) => [t.teamId, safeName(t.teamName)]));
  const nome = (id: string): string => nomi.get(id) ?? id;

  return {
    leagueId: meta.leagueId,
    leagueName: safeName(meta.leagueName, 60),
    matchday: input.matchday,
    season: input.roster.season,
    factEngineVersion: meta.factEngineVersion,
    kind: 'anteprima',
    facts: output.facts,
    // Vuoto e non opzionale: non esiste un tabellino di partite non giocate.
    results: [],
    fixtures: input.fixtures
      .filter((f) => nomi.has(f.homeTeamId) && nomi.has(f.awayTeamId))
      .map((f) => ({ homeTeam: nome(f.homeTeamId), awayTeam: nome(f.awayTeamId) })),
    standings: output.standings.map((r) => ({
      position: `${r.position}°`,
      teamName: nome(r.teamId),
      points: String(r.leaguePoints),
    })),
  };
}

export const __interni = { contiDelleSquadre, estremo, striscia };
