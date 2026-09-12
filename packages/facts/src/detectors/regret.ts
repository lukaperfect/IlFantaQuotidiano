import { fmt } from '@fantacomics/core';
import { pointsToGoals } from '@fantacomics/scoring';
import type { FactContext, FactDraft } from '../context.js';
import { playerRef, teamRef } from '../context.js';
import { drama, intensityOf } from '../drama.js';
import type { TeamView } from '../views.js';

/**
 * Il rimpianto scomposto. "Non hai perso per i giocatori, hai perso per il
 * 3-4-3" è una frase che si può dire solo se il numero esiste separatamente.
 */
export function detectRegret(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  // In modalità ridotta le controfattuali non sono attendibili: si tace.
  if (ctx.result.degraded) return out;

  const t = ctx.result.rules.goalThreshold;

  for (const v of views.values()) {
    const r = v.regret;
    // Senza un ottimo calcolabile, rimpianto ed efficienza sarebbero inventati.
    if (!r || !r.feasible) continue;

    const flips = (extra: number): boolean => {
      const newGoals = pointsToGoals(v.points + extra, t);
      return (v.outcome === 'L' && newGoals >= v.opponentGoals) ||
             (v.outcome === 'D' && newGoals > v.opponentGoals);
    };

    if (r.regretTotal >= 10) {
      out.push({
        type: 'REGRET_TOTALE',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          realizzati: fmt(v.points, 1),
          massimoPossibile: fmt(r.bestFullRoster, 1),
          rimpianto: fmt(r.regretTotal, 1),
          moduloOttimale: r.optimalModule,
          moduloSchierato: v.score.effective.effectiveModule,
        },
        polarity: 'tragedia',
        drama: drama(80, { intensity: intensityOf(r.regretTotal, 30) }),
        plain: `${ctx.teamName(v.teamId)} ha fatto ${fmt(v.points, 1)} punti su ${fmt(r.bestFullRoster, 1)} possibili: ${fmt(r.regretTotal, 1)} punti buttati.`,
        evidence: [{ source: 'xi-ottimale' }],
      });
    }

    if (r.regretBench >= 5) {
      const decisive = flips(r.regretBench);
      out.push({
        type: 'PANCHINA_D_ORO',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          rimpiantoPanchina: fmt(r.regretBench, 1),
          realizzati: fmt(v.points, 1),
          conLaPanchinaGiusta: fmt(r.bestSelectedSameModule, 1),
        },
        polarity: decisive ? 'tragedia' : 'farsa',
        drama: drama(decisive ? 88 : 68, { intensity: intensityOf(r.regretBench, 20) }),
        plain: `${ctx.teamName(v.teamId)} aveva ${fmt(r.regretBench, 1)} punti in panchina, con gli stessi convocati e lo stesso modulo.`,
        evidence: [{ source: 'regret-panchina' }],
      });
    }

    if (r.regretModule >= 3 && r.bestSelectedModule !== v.score.effective.effectiveModule) {
      const decisive = flips(r.regretModule);
      out.push({
        type: 'REGRET_MODULO',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          rimpiantoModulo: fmt(r.regretModule, 1),
          moduloSchierato: v.score.effective.effectiveModule,
          moduloMigliore: r.bestSelectedModule,
          realizzati: fmt(v.points, 1),
        },
        polarity: 'farsa',
        drama: drama(decisive ? 84 : 66, { intensity: intensityOf(r.regretModule, 12) }),
        plain: `Con gli stessi identici giocatori, ${ctx.teamName(v.teamId)} avrebbe fatto ${fmt(r.regretModule, 1)} punti in più passando dal ${v.score.effective.effectiveModule} al ${r.bestSelectedModule}.`,
        evidence: [{ source: 'regret-modulo' }],
      });
    }

    if (r.keyBenchPlayer && r.keyBenchPlayer.fantaVote >= 9 && flips(r.regretBench)) {
      out.push({
        type: 'PANCHINARO_DECISIVO',
        subjects: [teamRef(ctx, v.teamId), playerRef(ctx, r.keyBenchPlayer.playerId)],
        numbers: {
          fantavoto: fmt(r.keyBenchPlayer.fantaVote, 1),
          risultato: `${v.goals}-${v.opponentGoals}`,
          rimpiantoPanchina: fmt(r.regretBench, 1),
        },
        polarity: 'tragedia',
        drama: drama(91, { intensity: intensityOf(r.keyBenchPlayer.fantaVote, 16) }),
        plain: `${ctx.playerName(r.keyBenchPlayer.playerId)} ha fatto ${fmt(r.keyBenchPlayer.fantaVote, 1)} restando in panchina, e quel punteggio cambiava il risultato.`,
        evidence: [{ source: 'panchinaro-decisivo' }],
      });
    }
  }

  return out;
}
