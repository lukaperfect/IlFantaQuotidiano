import { fmt } from '@fantacomics/core';
import type { FactContext, FactDraft } from '../context.js';
import { teamRef } from '../context.js';
import { drama, intensityOf, percentileOf } from '../drama.js';
import type { TeamView } from '../views.js';

/**
 * Archi narrativi di stagione. È la continuità tra numeri che trasforma
 * 38 output isolati in un giornale — e la ragione per cui la lega si
 * riabbona l'anno dopo.
 */
export function detectHistory(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const history = ctx.history.entries;

  for (const v of views.values()) {
    // --- Record di lega ---
    const past = history.map((h) => h.points[v.teamId]).filter((p): p is number => p !== undefined);
    if (past.length >= 4) {
      const maxPast = Math.max(...past);
      const minPast = Math.min(...past);
      if (v.points > maxPast) {
        out.push({
          type: 'RECORD_POSITIVO_LEGA',
          subjects: [teamRef(ctx, v.teamId)],
          numbers: {
            punti: fmt(v.points, 1),
            precedenteRecord: fmt(maxPast, 1),
            giornateGiocate: String(past.length + 1),
          },
          polarity: 'trionfo',
          drama: drama(80, { intensity: intensityOf(v.points - maxPast, 15) }),
          plain: `${fmt(v.points, 1)} è il nuovo record stagionale di ${ctx.teamName(v.teamId)} (precedente ${fmt(maxPast, 1)}).`,
          evidence: [{ source: 'storico-lega' }],
        });
      }
      if (v.points < minPast) {
        out.push({
          type: 'RECORD_NEGATIVO_LEGA',
          subjects: [teamRef(ctx, v.teamId)],
          numbers: {
            punti: fmt(v.points, 1),
            precedentePeggio: fmt(minPast, 1),
            giornateGiocate: String(past.length + 1),
          },
          polarity: 'tragedia',
          drama: drama(82, { intensity: intensityOf(minPast - v.points, 15) }),
          plain: `${fmt(v.points, 1)} è il peggior punteggio stagionale di ${ctx.teamName(v.teamId)} (precedente ${fmt(minPast, 1)}).`,
          evidence: [{ source: 'storico-lega' }],
        });
      }
    }

    // --- Rarità cross-lega: credibile solo perché il dato esiste davvero ---
    const pct = percentileOf(ctx.corpus, v.points);
    if (pct !== null && (pct <= 3 || pct >= 97)) {
      out.push({
        type: 'PUNTEGGIO_RARO',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          punti: fmt(v.points, 1),
          percentile: `${pct.toFixed(1)}%`,
          verso: pct >= 97 ? 'alto' : 'basso',
        },
        polarity: pct >= 97 ? 'trionfo' : 'tragedia',
        drama: drama(78, { intensity: 1, rarityPercentile: pct }),
        plain: `${fmt(v.points, 1)} punti: ${pct >= 97 ? 'solo' : 'appena'} il ${pct >= 97 ? (100 - pct).toFixed(1) : pct.toFixed(1)}% dei punteggi registrati su FantaComics è ${pct >= 97 ? 'più alto' : 'più basso'}.`,
        evidence: [{ source: 'corpus-cross-lega' }],
      });
    }

    // --- Filotti e crolli ---
    const streak = currentStreak(ctx, v);
    if (streak.kind === 'W' && streak.length >= 3) {
      out.push({
        type: 'FILOTTO_VITTORIE',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: { vittorie: String(streak.length), punti: fmt(v.points, 1) },
        polarity: 'trionfo',
        drama: drama(72, { intensity: intensityOf(streak.length, 8) }),
        plain: `${ctx.teamName(v.teamId)} ha vinto ${streak.length} partite di fila.`,
        evidence: [{ source: 'serie-storica' }],
      });
    }
    if (streak.kind === 'L' && streak.length >= 3) {
      out.push({
        type: 'CROLLO_VERTICALE',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: { sconfitte: String(streak.length), punti: fmt(v.points, 1) },
        polarity: 'tragedia',
        drama: drama(76, { intensity: intensityOf(streak.length, 8) }),
        plain: `${ctx.teamName(v.teamId)} ha perso ${streak.length} partite di fila.`,
        evidence: [{ source: 'serie-storica' }],
      });
    }

    // --- Maledizione negli scontri diretti ---
    const curse = h2hLosingStreak(ctx, v);
    if (curse >= 3) {
      out.push({
        type: 'MALEDIZIONE_H2H',
        subjects: [teamRef(ctx, v.teamId), teamRef(ctx, v.opponentId)],
        numbers: { sconfitteConsecutive: String(curse), risultato: `${v.goals}-${v.opponentGoals}` },
        polarity: 'tragedia',
        drama: drama(79, { intensity: intensityOf(curse, 6) }),
        plain: `${ctx.teamName(v.teamId)} ha perso ${curse} scontri diretti consecutivi contro ${ctx.teamName(v.opponentId)}.`,
        evidence: [{ source: 'head-to-head' }],
      });
    }
  }

  // --- Movimenti di classifica ---
  out.push(...detectStandings(ctx, views));

  // --- Goleade ---
  for (const f of ctx.result.fixtures) {
    const diff = Math.abs(f.homeGoals - f.awayGoals);
    if (diff >= 3) {
      const winnerId = f.homeGoals > f.awayGoals ? f.homeTeamId : f.awayTeamId;
      const loserId = f.homeGoals > f.awayGoals ? f.awayTeamId : f.homeTeamId;
      out.push({
        type: 'GOLEADA',
        subjects: [teamRef(ctx, winnerId), teamRef(ctx, loserId)],
        numbers: {
          risultato: `${Math.max(f.homeGoals, f.awayGoals)}-${Math.min(f.homeGoals, f.awayGoals)}`,
          puntiVincente: fmt(Math.max(f.homeScore.total, f.awayScore.total), 1),
          puntiPerdente: fmt(Math.min(f.homeScore.total, f.awayScore.total), 1),
        },
        polarity: 'trionfo',
        drama: drama(66, { intensity: intensityOf(diff, 5) }),
        plain: `${ctx.teamName(winnerId)} ha travolto ${ctx.teamName(loserId)} ${Math.max(f.homeGoals, f.awayGoals)}-${Math.min(f.homeGoals, f.awayGoals)}.`,
        evidence: [{ source: 'tabellino' }],
      });
    }
  }

  return out;
}

function currentStreak(ctx: FactContext, v: TeamView): { kind: 'W' | 'D' | 'L'; length: number } {
  let length = 1;
  const kind = v.outcome;
  for (let i = ctx.history.entries.length - 1; i >= 0; i--) {
    if (ctx.history.entries[i]?.results[v.teamId] !== kind) break;
    length++;
  }
  return { kind, length };
}

function h2hLosingStreak(ctx: FactContext, v: TeamView): number {
  if (v.outcome !== 'L') return 0;
  let count = 1;
  for (let i = ctx.history.entries.length - 1; i >= 0; i--) {
    const e = ctx.history.entries[i];
    if (!e) break;
    if (e.opponents[v.teamId] !== v.opponentId) continue;
    if (e.results[v.teamId] === 'L') count++;
    else break;
  }
  return count;
}

/** Classifica dopo la giornata: standingsBefore + risultato corrente. */
function detectStandings(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const before = ctx.result.snapshot.standingsBefore;
  if (before.length < 2) return out;

  const beforeByTeam = new Map(before.map((r) => [r.teamId, r]));
  const rows = before.map((r) => {
    const v = views.get(r.teamId);
    const gained = v ? v.actualLeaguePoints : 0;
    return {
      teamId: r.teamId,
      points: r.points + gained,
      totalFantasyPoints: r.totalFantasyPoints + (v?.points ?? 0),
    };
  });
  rows.sort((a, b) => b.points - a.points || b.totalFantasyPoints - a.totalFantasyPoints);

  rows.forEach((row, idx) => {
    const newPos = idx + 1;
    const oldPos = beforeByTeam.get(row.teamId)?.position;
    if (oldPos === undefined || oldPos === newPos) return;

    if (newPos === 1 && oldPos !== 1) {
      out.push({
        type: 'NUOVO_LEADER',
        subjects: [teamRef(ctx, row.teamId)],
        numbers: {
          posizionePrecedente: `${oldPos}°`,
          puntiClassifica: String(row.points),
        },
        polarity: 'trionfo',
        drama: drama(84, { intensity: intensityOf(oldPos - 1, 5) }),
        plain: `${ctx.teamName(row.teamId)} è il nuovo capolista: era ${oldPos}°.`,
        evidence: [{ source: 'classifica' }],
      });
    } else if (Math.abs(oldPos - newPos) >= 2) {
      out.push({
        type: 'SORPASSO_CLASSIFICA',
        subjects: [teamRef(ctx, row.teamId)],
        numbers: {
          posizionePrecedente: `${oldPos}°`,
          posizioneAttuale: `${newPos}°`,
          posizioniGuadagnate: String(oldPos - newPos),
        },
        polarity: newPos < oldPos ? 'trionfo' : 'tragedia',
        drama: drama(60, { intensity: intensityOf(oldPos - newPos, 6) }),
        plain: `${ctx.teamName(row.teamId)} passa dal ${oldPos}° al ${newPos}° posto.`,
        evidence: [{ source: 'classifica' }],
      });
    }
  });

  return out;
}
