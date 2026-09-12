import { fmt, fmtSigned } from '@fantacomics/core';
import type { FactContext, FactDraft } from '../context.js';
import { teamRef } from '../context.js';
import { drama, intensityOf, percentileOf } from '../drama.js';
import type { TeamView } from '../views.js';

/**
 * Il girone virtuale di giornata.
 * "Avresti battuto 8 avversari su 9 e hai perso" è il certificato numerico
 * dell'ingiustizia: non un'opinione, un fatto verificabile.
 */
export function detectLuck(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const all = [...views.values()];
  if (all.length < 2) return out;
  const opponentsCount = all.length - 1;

  for (const v of all) {
    const winRate = opponentsCount === 0 ? 0 : v.virtualWins / opponentsCount;

    if (v.outcome === 'L' && winRate >= 0.6) {
      out.push({
        type: 'SFIGA_CERTIFICATA',
        subjects: [teamRef(ctx, v.teamId), teamRef(ctx, v.opponentId)],
        numbers: {
          battuti: String(v.virtualWins),
          avversariTotali: String(opponentsCount),
          punti: fmt(v.points, 1),
          puntiAvversario: fmt(v.opponentPoints, 1),
          scarto: fmt(v.pointsMargin, 1),
          puntiAttesi: fmt(v.expectedLeaguePoints, 1),
          indiceSfortuna: fmtSigned(v.luckDelta, 1),
        },
        polarity: 'ingiustizia',
        drama: drama(88, { intensity: winRate }),
        plain: `${ctx.teamName(v.teamId)} avrebbe battuto ${v.virtualWins} avversari su ${opponentsCount} con ${fmt(v.points, 1)} punti, ma ha pescato ${ctx.teamName(v.opponentId)} e ha perso.`,
        evidence: [{ source: 'girone-virtuale', detail: `${v.virtualWins}W/${v.virtualDraws}D/${v.virtualLosses}L` }],
      });
    }

    if (v.outcome === 'W' && winRate <= 0.35) {
      out.push({
        type: 'CULO_CERTIFICATO',
        subjects: [teamRef(ctx, v.teamId), teamRef(ctx, v.opponentId)],
        numbers: {
          battuti: String(v.virtualWins),
          avversariTotali: String(opponentsCount),
          punti: fmt(v.points, 1),
          puntiAvversario: fmt(v.opponentPoints, 1),
          indiceFortuna: fmtSigned(v.luckDelta, 1),
        },
        polarity: 'farsa',
        drama: drama(78, { intensity: 1 - winRate }),
        plain: `${ctx.teamName(v.teamId)} ha vinto con ${fmt(v.points, 1)} punti pur avendone fatti meno di ${opponentsCount - v.virtualWins} avversari su ${opponentsCount}.`,
        evidence: [{ source: 'girone-virtuale', detail: `${v.virtualWins}W/${v.virtualDraws}D/${v.virtualLosses}L` }],
      });
    }
  }

  /**
   * Attenzione: chi fa il MASSIMO dei punti non puo' perdere, perche' la
   * conversione punti->gol e' monotona. Il fatto interessante e' quindi
   * "il miglior punteggio tra chi NON ha vinto", non "il miglior punteggio
   * in assoluto, se ha perso" — che sarebbe una condizione irraggiungibile.
   */
  const sorted = [...all].sort((a, b) => a.points - b.points);
  const median = sorted[Math.floor(sorted.length / 2)]?.points ?? 0;

  const losers = all.filter((v) => v.outcome !== 'W');
  const best = losers.length > 0 ? losers.reduce((a, b) => (b.points > a.points ? b : a)) : null;
  if (best && best.points >= median) {
    out.push({
      type: 'MIGLIOR_PUNTEGGIO_SCONFITTO',
      subjects: [teamRef(ctx, best.teamId), teamRef(ctx, best.opponentId)],
      numbers: {
        punti: fmt(best.points, 1),
        puntiAvversario: fmt(best.opponentPoints, 1),
        scarto: fmt(best.pointsMargin, 1),
      },
      polarity: 'ingiustizia',
      drama: drama(92, { intensity: 1, rarityPercentile: percentileOf(ctx.corpus, best.points) }),
      plain: `${ctx.teamName(best.teamId)} ha fatto ${fmt(best.points, 1)} punti, più della metà della lega, e non ha vinto.`,
      evidence: [{ source: 'classifica-giornata' }],
    });
  }

  const winners = all.filter((v) => v.outcome === 'W');
  const worst = winners.length > 0 ? winners.reduce((a, b) => (b.points < a.points ? b : a)) : null;
  if (worst && worst.points <= median) {
    out.push({
      type: 'PEGGIOR_PUNTEGGIO_VINCENTE',
      subjects: [teamRef(ctx, worst.teamId), teamRef(ctx, worst.opponentId)],
      numbers: {
        punti: fmt(worst.points, 1),
        puntiAvversario: fmt(worst.opponentPoints, 1),
      },
      polarity: 'farsa',
      drama: drama(84, { intensity: 1 }),
      plain: `${ctx.teamName(worst.teamId)} ha vinto con ${fmt(worst.points, 1)} punti, sotto la mediana della giornata.`,
      evidence: [{ source: 'classifica-giornata' }],
    });
  }

  // Ingiustizia cumulata: il numero che vive tutta la stagione.
  for (const v of all) {
    let cumulative = v.luckDelta;
    for (const entry of ctx.history.entries) {
      cumulative += entry.luckDelta?.[v.teamId] ?? 0;
    }
    cumulative = Math.round(cumulative * 100) / 100;
    if (Math.abs(cumulative) >= 4 && ctx.history.entries.length >= 3) {
      const robbed = cumulative < 0;
      out.push({
        type: 'INGIUSTIZIA_STAGIONALE',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          indiceCumulato: fmtSigned(cumulative, 1),
          giornate: String(ctx.history.entries.length + 1),
        },
        polarity: robbed ? 'ingiustizia' : 'farsa',
        drama: drama(72, { intensity: intensityOf(cumulative, 12) }),
        plain: robbed
          ? `${ctx.teamName(v.teamId)} ha ${fmtSigned(cumulative, 1)} punti di classifica rispetto a quanto meritato in ${ctx.history.entries.length + 1} giornate.`
          : `${ctx.teamName(v.teamId)} ha incassato ${fmtSigned(cumulative, 1)} punti di classifica più di quanto i suoi punteggi meritassero.`,
        evidence: [{ source: 'indice-ingiustizia-cosmica' }],
      });
    }
  }

  return out;
}
