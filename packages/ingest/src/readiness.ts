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
