import type { MatchdayReadiness } from '@fantacomics/core';

/**
 * LA GIORNATA NON È PRONTA IL MARTEDÌ. È PRONTA QUANDO È PRONTA.
 *
 * La Serie A gioca il lunedì sera, ha turni infrasettimanali, rinvii e voti
 * che vengono rettificati. Un cron fisso pubblica giornali sbagliati con
 * puntualità svizzera. Il cron decide solo QUANDO CONSEGNARE; questa macchina
 * a stati decide QUANDO È PRONTO, e sono due domande diverse.
 */

export type Observation = {
  fetchedAt: string;
  /** Hash del contenuto: due letture identiche = voti stabili. */
  contentHash: string;
  matchesFinished: number;
  matchesTotal: number;
  /** Quanti giocatori hanno un voto (non SV) sul totale di quelli che hanno giocato. */
  playersRated: number;
  playersExpected: number;
};

export type ReadinessDecision = {
  state: MatchdayReadiness;
  ready: boolean;
  reason: string;
  /** Fra quanti secondi ha senso ricontrollare. */
  recheckAfterSeconds: number;
};

export type ReadinessPolicy = {
  /** Quota minima di giocatori con voto per considerare i voti completi. */
  minRatedRatio: number;
  /** Quante letture consecutive identiche servono per dichiarare stabile. */
  stableReads: number;
};

export const DEFAULT_POLICY: ReadinessPolicy = { minRatedRatio: 0.9, stableReads: 2 };

/**
 * `history` è ordinata dalla più vecchia alla più recente e include
 * l'osservazione corrente come ultimo elemento.
 */
export function evaluateReadiness(
  history: readonly Observation[],
  policy: ReadinessPolicy = DEFAULT_POLICY,
): ReadinessDecision {
  const latest = history[history.length - 1];
  if (!latest) {
    return {
      state: 'GIORNATA_APERTA', ready: false,
      reason: 'Nessuna osservazione disponibile.',
      recheckAfterSeconds: 3600,
    };
  }

  if (latest.matchesFinished < latest.matchesTotal) {
    const mancanti = latest.matchesTotal - latest.matchesFinished;
    return {
      state: 'GIORNATA_APERTA', ready: false,
      reason: `${mancanti} partite ancora da giocare (posticipi o turno infrasettimanale).`,
      // Non ha senso ripassare tra un minuto: manca una partita intera.
      recheckAfterSeconds: 3600,
    };
  }

  const ratio = latest.playersExpected === 0 ? 0 : latest.playersRated / latest.playersExpected;
  if (ratio < policy.minRatedRatio) {
    return {
      state: 'VOTI_PARZIALI', ready: false,
      reason: `Voti al ${(ratio * 100).toFixed(0)}%, soglia ${(policy.minRatedRatio * 100).toFixed(0)}%.`,
      recheckAfterSeconds: 900,
    };
  }

  const recent = history.slice(-policy.stableReads);
  const stable =
    recent.length >= policy.stableReads &&
    recent.every((o) => o.contentHash === latest.contentHash);

  if (!stable) {
    return {
      state: 'VOTI_PARZIALI', ready: false,
      reason: `Voti completi ma non ancora stabili: servono ${policy.stableReads} letture identiche consecutive.`,
      recheckAfterSeconds: 900,
    };
  }

  return {
    state: 'VOTI_DEFINITIVI', ready: true,
    reason: 'Partite concluse, voti completi e stabili su letture consecutive.',
    recheckAfterSeconds: 0,
  };
}

/**
 * La finestra di consegna è una scelta dell'admin, non del sistema.
 * Ogni lega ha i suoi ritmi: c'è chi legge il giornale in ufficio il martedì
 * mattina e chi lo vuole appena i voti sono chiusi.
 */
export type DeliveryWindow = {
  /** 0 = domenica. */
  weekday: number;
  hour: number;
  minute: number;
  timezone: string;
};

export const DEFAULT_DELIVERY: DeliveryWindow = {
  weekday: 2, hour: 9, minute: 0, timezone: 'Europe/Rome',
};

/** Vero se è già passata la finestra di consegna per una giornata pronta. */
export function shouldDeliver(
  decision: ReadinessDecision,
  now: Date,
  window: DeliveryWindow = DEFAULT_DELIVERY,
): { deliver: boolean; reason: string } {
  if (!decision.ready) return { deliver: false, reason: decision.reason };

  const local = new Date(now.toLocaleString('en-US', { timeZone: window.timezone }));
  const minutesNow = local.getHours() * 60 + local.getMinutes();
  const minutesWindow = window.hour * 60 + window.minute;

  if (local.getDay() === window.weekday && minutesNow >= minutesWindow) {
    return { deliver: true, reason: 'Giornata pronta e finestra di consegna aperta.' };
  }
  // Una giornata pronta ma in ritardo (posticipo, rinvio) si consegna subito:
  // aspettare il martedì successivo significherebbe non consegnarla mai.
  if (decision.ready && local.getDay() !== window.weekday) {
    const daysSince = (local.getDay() - window.weekday + 7) % 7;
    if (daysSince > 0 && daysSince < 5) {
      return { deliver: true, reason: 'Giornata pronta oltre la finestra: consegna immediata.' };
    }
  }
  return { deliver: false, reason: 'Giornata pronta, in attesa della finestra di consegna.' };
}

/**
 * L'osservazione ricavata dai dati stessi.
 *
 * Serve al percorso dell'estensione, dove non esiste un osservatore che
 * ricontrolla a intervalli: c'e' una persona che preme "Cattura" quando le
 * pare. Se preme di domenica sera, meta' Serie A non ha ancora giocato e il
 * giornale esce pieno di senza voto — con la riconciliazione che non se ne
 * accorge, perche' i punteggi ufficiali parziali tornano benissimo con quelli
 * parziali ricalcolati.
 *
 * IL SEGNALE GIUSTO NON E' LA QUOTA DI VOTI.
 *
 * La prima versione contava i titolari con un voto e chiedeva il 90%. Misurato
 * sui dati, una giornata COMPLETA sta fra il 67% e l'81%: i senza voto
 * esistono e sono legittimi. Una soglia su quel numero boccia giornate finite,
 * che e' il modo peggiore di sbagliare — l'utente non capisce perche' e smette
 * di fidarsi del controllo.
 *
 * Il segnale che separa i due casi in modo netto e' STRUTTURALE: una squadra di
 * Serie A che non ha ancora giocato non ha NESSUN voto, mentre una che ha
 * giocato ne ha undici. Misurato: 20 squadre su 20 a giornata completa, 10 su
 * 20 a meta' giornata, identico su ogni seed. Non dipende da quanti senza voto
 * ci siano, che e' proprio la quantita' che non posso calibrare senza dati
 * veri.
 */
export function osservazioneDaGiornata(
  players: readonly { serieATeam: string; playerId: string; vote: number | null }[],
  lineups: readonly { starters: readonly { playerId: string }[] }[],
  opts: { fetchedAt: string; contentHash: string },
): Observation & { squadreSenzaVoto: string[] } {
  const squadre = new Set(players.map((p) => p.serieATeam));
  const conVoto = new Set(players.filter((p) => p.vote !== null).map((p) => p.serieATeam));
  const senzaVoto = [...squadre].filter((t) => !conVoto.has(t)).sort();

  /**
   * Due squadre per partita, cosi' il messaggio della macchina a stati
   * ("N partite ancora da giocare") resta quello vero.
   *
   * L'arrotondamento va per DIFETTO sulle giocate, e non e' un dettaglio:
   * con `ceil`, 19 squadre su 20 davano 10 partite su 10 e un rinvio passava
   * inosservato. Una squadra senza voti significa che la sua partita non e'
   * completa, quindi quella partita non si conta. Quando non ne manca
   * nessuna si prende il totale, altrimenti un numero dispari di squadre
   * non arriverebbe mai a pareggiare il conto.
   */
  const partiteTotali = Math.ceil(squadre.size / 2);
  const partiteGiocate = senzaVoto.length === 0
    ? partiteTotali
    : Math.floor(conVoto.size / 2);

  const voti = new Map(players.map((p) => [p.playerId, p.vote]));
  const schierati = lineups.flatMap((l) => l.starters.map((s) => s.playerId));

  return {
    fetchedAt: opts.fetchedAt,
    contentHash: opts.contentHash,
    matchesFinished: partiteGiocate,
    matchesTotal: partiteTotali,
    playersRated: schierati.filter((id) => (voti.get(id) ?? null) !== null).length,
    playersExpected: schierati.length,
    squadreSenzaVoto: senzaVoto,
  };
}

/**
 * La politica per una lettura sola.
 *
 * `stableReads: 1` non e' un allentamento: qui non ci sono letture consecutive
 * da confrontare, perche' e' l'utente a decidere quando leggere. Il criterio
 * che porta il peso e' quello sulle partite, che qui e' strutturale ed esatto.
 *
 * `minRatedRatio` sta al 50% come rete di sicurezza, non come criterio: serve
 * a cogliere una cattura degenere — le squadre risultano presenti ma i voti
 * quasi tutti assenti — non a giudicare quanti senza voto siano normali. Una
 * giornata completa misura fra il 67% e l'81%, quindi il margine c'e'.
 */
export const POLITICA_LETTURA_SINGOLA: ReadinessPolicy = { minRatedRatio: 0.5, stableReads: 1 };

/**
 * La politica del percorso automatico.
 *
 * Numeri identici al valore predefinito, ma il nome dice a quale strada
 * appartengono e il commento dice perche' reggono — che e' l'informazione che
 * serve il giorno in cui qualcuno vorra' cambiarli.
 *
 * `stableReads: 2` qui e' possibile e necessario. Possibile perche' il cron
 * ripassa da solo, a differenza dell'estensione dove c'e' una persona che
 * preme quando le pare. Necessario perche' il controllo strutturale, da solo,
 * si apre troppo presto su questo percorso: i voti arrivano a poco a poco, e
 * appena OGNI squadra ha il suo primo voto il cancello passerebbe. Misurato:
 * con il 20% dei voti distribuiti su tutte le squadre il rapporto e' al 18%
 * ma tutte le squadre risultano "in campo".
 *
 * `minRatedRatio: 0.9` e' alto e stavolta e' giustificato, non indovinato,
 * perche' cambia il DENOMINATORE: qui si contano i giocatori che hanno
 * giocato dei minuti, non i titolari schierati. Chi e' sceso in campo ha un
 * voto per definizione — e' la promessa di chi i voti li pubblica — mentre i
 * titolari schierati includono i senza voto legittimi, che sono proprio la
 * quantita' che avevo sbagliato a calibrare la prima volta.
 */
export const POLITICA_CRON: ReadinessPolicy = { minRatedRatio: 0.9, stableReads: 2 };
