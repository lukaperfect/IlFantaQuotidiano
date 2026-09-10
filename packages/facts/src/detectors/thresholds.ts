import { fmt } from '@fantacomics/core';
import { distanceToNextGoal, marginOverThreshold, pointsToGoals } from '@fantacomics/scoring';
import type { FactContext, FactDraft } from '../context.js';
import { playerRef, teamRef } from '../context.js';
import { drama, intensityOf } from '../drama.js';
import type { TeamView } from '../views.js';

/**
 * Soglie e decimi: la famiglia di fatti che l'utente ha citato per prima,
 * e la più sottovalutata. Il 71.5 non è un aneddoto, è
 * `distanceToNextGoal(71.5) === 0.5` — e quel mezzo punto ha spesso un colpevole
 * con nome e cognome.
 */
export function detectThresholds(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const t = ctx.result.rules.goalThreshold;

  for (const v of views.values()) {
    const missing = distanceToNextGoal(v.points, t);
    const margin = marginOverThreshold(v.points, t);

    // La beffa: a un soffio dal gol che avrebbe cambiato il risultato.
    if (missing <= 0.5) {
      const goalsWithExtra = pointsToGoals(v.points + missing, t);
      const wouldHaveChanged =
        (v.outcome === 'L' && goalsWithExtra >= v.opponentGoals) ||
        (v.outcome === 'D' && goalsWithExtra > v.opponentGoals);

      out.push({
        type: 'SOGLIA_GOL_SFIORATA',
        subjects: [teamRef(ctx, v.teamId), teamRef(ctx, v.opponentId)],
        numbers: {
          punti: fmt(v.points, 1),
          mancanti: fmt(missing, 1),
          sogliaProssima: fmt(v.points + missing, 1),
          golAttuali: String(v.goals),
          golPotenziali: String(goalsWithExtra),
          risultato: `${v.goals}-${v.opponentGoals}`,
        },
        polarity: wouldHaveChanged ? 'tragedia' : 'farsa',
        drama: drama(wouldHaveChanged ? 94 : 62, { intensity: 1 - missing / 0.5 }),
        plain: wouldHaveChanged
          ? `${ctx.teamName(v.teamId)} si è fermato a ${fmt(v.points, 1)}: ${fmt(missing, 1)} punti in più valevano un gol e un altro risultato.`
          : `${ctx.teamName(v.teamId)} ha chiuso a ${fmt(v.points, 1)}, a ${fmt(missing, 1)} dalla soglia successiva.`,
        evidence: [{ source: 'soglie-gol', detail: `base ${t.base}, step ${t.step}` }],
      });

      // Il colpevole del decimo: un giallo vale -0.5, esattamente la distanza tipica.
      const culprit = findMalusCulprit(ctx, v, missing);
      if (culprit) {
        out.push({
          type: 'COLPEVOLE_DEL_DECIMO',
          subjects: [teamRef(ctx, v.teamId), playerRef(ctx, culprit.playerId)],
          numbers: {
            malus: fmt(culprit.malus, 1),
            mancanti: fmt(missing, 1),
            punti: fmt(v.points, 1),
            causa: culprit.label,
          },
          polarity: 'tragedia',
          drama: drama(90, { intensity: 1 }),
          plain: `Il ${culprit.label} di ${ctx.playerName(culprit.playerId)} è costato ${fmt(culprit.malus, 1)}: esattamente quanto mancava a ${ctx.teamName(v.teamId)} per il gol.`,
          evidence: [{ source: 'malus-decisivo', detail: culprit.playerId }],
        });
      }
    }

    // Soglia agguantata per un pelo: il rovescio comico della beffa.
    if (margin !== null && margin <= 0.5 && v.goals > 0) {
      const esatto = margin === 0;
      out.push({
        type: 'SOGLIA_GOL_AGGUANTATA',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          punti: fmt(v.points, 1),
          margine: fmt(margin, 1),
          gol: String(v.goals),
          sogliaEsatta: esatto ? 'si' : 'no',
        },
        polarity: 'trionfo',
        // Fermarsi ESATTAMENTE sulla soglia e' piu' raro e piu' comico che sfiorarla.
        drama: drama(esatto ? 74 : 58, { intensity: 1 - margin / 0.5 }),
        plain: esatto
          ? `${ctx.teamName(v.teamId)} ha chiuso a ${fmt(v.points, 1)}, esattamente sulla soglia del ${v.goals}° gol.`
          : `${ctx.teamName(v.teamId)} ha agguantato il ${v.goals}° gol per ${fmt(margin, 1)} punti.`,
        evidence: [{ source: 'soglie-gol' }],
      });
    }
  }

  for (const f of ctx.result.fixtures) {
    const home = views.get(f.homeTeamId);
    const away = views.get(f.awayTeamId);
    if (!home || !away) continue;

    // Sconfitta per un soffio di punti.
    if (f.outcome !== 'draw' && f.pointsMargin <= 1) {
      const loser = f.outcome === 'home' ? away : home;
      const winner = f.outcome === 'home' ? home : away;
      out.push({
        type: 'BEFFA_DECIMALE',
        subjects: [teamRef(ctx, loser.teamId), teamRef(ctx, winner.teamId)],
        numbers: {
          scarto: fmt(f.pointsMargin, 1),
          puntiPerdente: fmt(loser.points, 1),
          puntiVincente: fmt(winner.points, 1),
          risultato: `${winner.goals}-${loser.goals}`,
        },
        polarity: 'tragedia',
        drama: drama(86, { intensity: 1 - f.pointsMargin }),
        plain: `${ctx.teamName(loser.teamId)} ha perso per ${fmt(f.pointsMargin, 1)} punti: ${fmt(loser.points, 1)} contro ${fmt(winner.points, 1)}.`,
        evidence: [{ source: 'scarto-punti' }],
      });
    }

    // Pareggio nonostante un divario di punti largo: la crudeltà delle soglie.
    if (f.outcome === 'draw' && f.pointsMargin >= 3) {
      const better = home.points > away.points ? home : away;
      const worse = home.points > away.points ? away : home;
      out.push({
        type: 'PAREGGIO_NOIOSO',
        subjects: [teamRef(ctx, better.teamId), teamRef(ctx, worse.teamId)],
        numbers: {
          scarto: fmt(f.pointsMargin, 1),
          puntiMigliore: fmt(better.points, 1),
          puntiPeggiore: fmt(worse.points, 1),
          risultato: `${home.goals}-${away.goals}`,
        },
        polarity: 'ingiustizia',
        drama: drama(70, { intensity: intensityOf(f.pointsMargin, 10) }),
        plain: `${ctx.teamName(better.teamId)} ha fatto ${fmt(f.pointsMargin, 1)} punti più di ${ctx.teamName(worse.teamId)} e ha pareggiato.`,
        evidence: [{ source: 'soglie-gol' }],
      });
    }
  }

  return out;
}

/**
 * Cerca un malus la cui entità coincide con i punti mancanti.
 * È il fatto più specifico dell'intero motore: nomina il responsabile.
 */
function findMalusCulprit(
  ctx: FactContext,
  view: TeamView,
  missing: number,
): { playerId: string; malus: number; label: string } | null {
  const bonus = ctx.result.rules.bonus;
  for (const p of view.score.effective.slots) {
    const st = ctx.stat(p.playerId);
    if (!st) continue;
    const candidates: { malus: number; label: string }[] = [];
    if (st.events.yellowCards > 0) candidates.push({ malus: Math.abs(bonus.yellowCard), label: 'giallo' });
    if (st.events.redCards > 0) candidates.push({ malus: Math.abs(bonus.redCard), label: 'rosso' });
    if (st.events.penaltiesMissed > 0) candidates.push({ malus: Math.abs(bonus.penaltyMissed), label: 'rigore sbagliato' });
    if (st.events.ownGoals > 0) candidates.push({ malus: Math.abs(bonus.ownGoal), label: 'autogol' });

    for (const c of candidates) {
      if (c.malus > 0 && c.malus >= missing && c.malus - missing < 1e-9 + 0.001) {
        return { playerId: p.playerId, malus: c.malus, label: c.label };
      }
    }
  }
  return null;
}
