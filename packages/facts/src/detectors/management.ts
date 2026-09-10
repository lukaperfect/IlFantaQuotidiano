import { fmt } from '@fantacomics/core';
import type { FactContext, FactDraft } from '../context.js';
import { playerRef, teamRef } from '../context.js';
import { drama, intensityOf } from '../drama.js';
import type { TeamView } from '../views.js';

/** Disciplina di gestione: chi non schiera, chi finisce i cambi, chi sbaglia sistematicamente. */
export function detectManagement(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const lineups = new Map(ctx.result.snapshot.lineups.map((l) => [l.teamId, l]));

  for (const v of views.values()) {
    const lineup = lineups.get(v.teamId);

    if (lineup?.autoFilled) {
      out.push({
        type: 'FORMAZIONE_NON_SCHIERATA',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: { punti: fmt(v.points, 1), risultato: `${v.goals}-${v.opponentGoals}` },
        polarity: v.outcome === 'W' ? 'farsa' : 'mediocrita',
        drama: drama(v.outcome === 'W' ? 82 : 64, { intensity: 1 }),
        plain: `${ctx.teamName(v.teamId)} non ha schierato la formazione${v.outcome === 'W' ? ' e ha vinto lo stesso' : ''}.`,
        evidence: [{ source: 'formazione-automatica' }],
      });
    }

    const unreplaced = v.score.effective.unreplacedSV;
    if (unreplaced.length > 0) {
      out.push({
        type: 'SOSTITUZIONI_ESAURITE',
        subjects: [teamRef(ctx, v.teamId), ...unreplaced.slice(0, 2).map((s) => playerRef(ctx, s.playerId))],
        numbers: {
          senzaVoto: String(unreplaced.length),
          cambiUsati: String(v.score.effective.substitutions.length),
          cambiDisponibili: String(ctx.result.rules.substitutions.max),
          punti: fmt(v.points, 1),
        },
        polarity: 'tragedia',
        drama: drama(74, { intensity: intensityOf(unreplaced.length, 4) }),
        plain: `${ctx.teamName(v.teamId)} ha finito i cambi con ${unreplaced.length} giocatori senza voto ancora in campo.`,
        evidence: [{ source: 'sostituzioni' }],
      });
    }

    const svCount = v.score.perPlayer.filter((p) => p.fantaVote === null).length;
    if (svCount >= 3) {
      out.push({
        type: 'PIOGGIA_DI_SV',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: { senzaVoto: String(svCount), punti: fmt(v.points, 1) },
        polarity: 'tragedia',
        drama: drama(70, { intensity: intensityOf(svCount, 5) }),
        plain: `${ctx.teamName(v.teamId)} ha schierato ${svCount} giocatori finiti senza voto.`,
        evidence: [{ source: 'conteggio-sv' }],
      });
    }
  }

  // Efficienza: realizzato / massimo possibile dalla rosa.
  if (!ctx.result.degraded) {
    const eff = [...views.values()]
      .filter((v) => v.regret?.feasible === true && v.regret.bestFullRoster > 0)
      .map((v) => ({ v, ratio: v.points / (v.regret as { bestFullRoster: number }).bestFullRoster }));

    if (eff.length >= 3) {
      const best = eff.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      const worst = eff.reduce((a, b) => (b.ratio < a.ratio ? b : a));

      out.push({
        type: 'EFFICIENZA_MASSIMA',
        subjects: [teamRef(ctx, best.v.teamId)],
        numbers: {
          efficienza: `${(best.ratio * 100).toFixed(1)}%`,
          realizzati: fmt(best.v.points, 1),
          massimo: fmt(best.v.regret?.bestFullRoster ?? 0, 1),
        },
        polarity: 'trionfo',
        drama: drama(60, { intensity: best.ratio }),
        plain: `${ctx.teamName(best.v.teamId)} ha estratto il ${(best.ratio * 100).toFixed(1)}% del massimo ottenibile dalla sua rosa.`,
        evidence: [{ source: 'efficienza-allenatore' }],
      });

      out.push({
        type: 'EFFICIENZA_MINIMA',
        subjects: [teamRef(ctx, worst.v.teamId)],
        numbers: {
          efficienza: `${(worst.ratio * 100).toFixed(1)}%`,
          realizzati: fmt(worst.v.points, 1),
          massimo: fmt(worst.v.regret?.bestFullRoster ?? 0, 1),
          sprecati: fmt((worst.v.regret?.bestFullRoster ?? 0) - worst.v.points, 1),
        },
        polarity: 'farsa',
        drama: drama(76, { intensity: 1 - worst.ratio }),
        plain: `${ctx.teamName(worst.v.teamId)} ha estratto solo il ${(worst.ratio * 100).toFixed(1)}% di quanto la sua rosa poteva dare.`,
        evidence: [{ source: 'efficienza-allenatore' }],
      });
    }
  }

  return out;
}
