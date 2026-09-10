import { fmt } from '@fantacomics/core';
import { computeFantaVote } from '@fantacomics/scoring';
import type { FactContext, FactDraft } from '../context.js';
import { playerRef, teamRef } from '../context.js';
import { drama, intensityOf, percentileOf } from '../drama.js';
import type { TeamView } from '../views.js';

type Performance = { playerId: string; teamId: string; fv: number; role: string };

/** Prestazioni individuali, xG e flop d'asta: il materiale delle pagelle. */
export function detectPlayers(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const perfs: Performance[] = [];

  for (const v of views.values()) {
    for (const p of v.score.perPlayer) {
      if (p.fantaVote === null) continue;
      perfs.push({ playerId: p.playerId, teamId: v.teamId, fv: p.fantaVote, role: p.role });
    }
  }
  if (perfs.length === 0) return out;

  const top = perfs.reduce((a, b) => (b.fv > a.fv ? b : a));
  const flop = perfs.reduce((a, b) => (b.fv < a.fv ? b : a));

  out.push({
    type: 'MIGLIOR_GIOCATORE_LEGA',
    subjects: [playerRef(ctx, top.playerId), teamRef(ctx, top.teamId)],
    numbers: { fantavoto: fmt(top.fv, 1), voto: fmt(ctx.stat(top.playerId)?.vote ?? 0, 1) },
    polarity: 'trionfo',
    drama: drama(64, { intensity: intensityOf(top.fv, 18) }),
    plain: `${ctx.playerName(top.playerId)} è il miglior fantavoto di giornata della lega: ${fmt(top.fv, 1)}.`,
    evidence: [{ source: 'pagelle' }],
  });

  out.push({
    type: 'PEGGIOR_GIOCATORE_LEGA',
    subjects: [playerRef(ctx, flop.playerId), teamRef(ctx, flop.teamId)],
    numbers: { fantavoto: fmt(flop.fv, 1), voto: fmt(ctx.stat(flop.playerId)?.vote ?? 0, 1) },
    polarity: 'farsa',
    drama: drama(70, { intensity: intensityOf(6 - flop.fv, 8) }),
    plain: `${ctx.playerName(flop.playerId)} è il peggior fantavoto di giornata della lega: ${fmt(flop.fv, 1)}.`,
    evidence: [{ source: 'pagelle' }],
  });

  // Miglior e peggior punteggio di squadra della giornata.
  const all = [...views.values()];
  const bestTeam = all.reduce((a, b) => (b.points > a.points ? b : a));
  const worstTeam = all.reduce((a, b) => (b.points < a.points ? b : a));

  out.push({
    type: 'TOP_GIORNATA',
    subjects: [teamRef(ctx, bestTeam.teamId)],
    numbers: { punti: fmt(bestTeam.points, 1), gol: String(bestTeam.goals) },
    polarity: 'trionfo',
    drama: drama(62, { intensity: 0.8, rarityPercentile: percentileOf(ctx.corpus, bestTeam.points) }),
    plain: `${ctx.teamName(bestTeam.teamId)} ha il miglior punteggio di giornata: ${fmt(bestTeam.points, 1)}.`,
    evidence: [{ source: 'classifica-giornata' }],
  });

  out.push({
    type: 'FLOP_GIORNATA',
    subjects: [teamRef(ctx, worstTeam.teamId)],
    numbers: { punti: fmt(worstTeam.points, 1), gol: String(worstTeam.goals) },
    polarity: 'farsa',
    drama: drama(68, { intensity: 0.8, rarityPercentile: percentileOf(ctx.corpus, worstTeam.points) }),
    plain: `${ctx.teamName(worstTeam.teamId)} ha il peggior punteggio di giornata: ${fmt(worstTeam.points, 1)}.`,
    evidence: [{ source: 'classifica-giornata' }],
  });

  for (const v of views.values()) {
    for (const p of v.score.perPlayer) {
      const st = ctx.stat(p.playerId);
      if (!st || st.vote === null) continue;

      if (p.role === 'P') {
        if (st.events.goalsConceded >= 4 || (p.fantaVote !== null && p.fantaVote <= 2)) {
          out.push({
            type: 'DISASTRO_PORTIERE',
            subjects: [playerRef(ctx, p.playerId), teamRef(ctx, v.teamId)],
            numbers: {
              golSubiti: String(st.events.goalsConceded),
              fantavoto: fmt(p.fantaVote ?? 0, 1),
              voto: fmt(st.vote, 1),
            },
            polarity: 'tragedia',
            drama: drama(75, { intensity: intensityOf(st.events.goalsConceded, 6) }),
            plain: `${ctx.playerName(p.playerId)} ha subito ${st.events.goalsConceded} gol: fantavoto ${fmt(p.fantaVote ?? 0, 1)}.`,
            evidence: [{ source: 'portiere' }],
          });
        }
        if (st.events.goalsConceded === 0 && st.vote >= 6.5) {
          out.push({
            type: 'PORTA_INVIOLATA',
            subjects: [playerRef(ctx, p.playerId), teamRef(ctx, v.teamId)],
            numbers: { voto: fmt(st.vote, 1), fantavoto: fmt(p.fantaVote ?? 0, 1) },
            polarity: 'trionfo',
            drama: drama(52, { intensity: intensityOf(st.vote - 6, 2) }),
            plain: `${ctx.playerName(p.playerId)} ha tenuto la porta inviolata con ${fmt(st.vote, 1)}.`,
            evidence: [{ source: 'portiere' }],
          });
        }
      }

      if (st.events.redCards > 0) {
        out.push({
          type: 'ESPULSIONE_PESANTE',
          subjects: [playerRef(ctx, p.playerId), teamRef(ctx, v.teamId)],
          numbers: { fantavoto: fmt(p.fantaVote ?? 0, 1), minuti: String(st.minutes) },
          polarity: 'farsa',
          drama: drama(72, { intensity: 1 - st.minutes / 90 }),
          plain: `${ctx.playerName(p.playerId)} è stato espulso al ${st.minutes}' lasciando ${fmt(p.fantaVote ?? 0, 1)} a ${ctx.teamName(v.teamId)}.`,
          evidence: [{ source: 'cartellini' }],
        });
      }

      // xG: la differenza tra quello che è successo e quello che doveva succedere.
      if (st.xG !== null && st.xG >= 1.0 && st.events.goals === 0) {
        out.push({
          type: 'CECCHINO_SENZA_MIRA',
          subjects: [playerRef(ctx, p.playerId), teamRef(ctx, v.teamId)],
          numbers: { xG: st.xG.toFixed(2), gol: '0', fantavoto: fmt(p.fantaVote ?? 0, 1) },
          polarity: 'farsa',
          drama: drama(74, { intensity: intensityOf(st.xG, 2.5) }),
          plain: `${ctx.playerName(p.playerId)} ha prodotto ${st.xG.toFixed(2)} xG e non ha segnato.`,
          evidence: [{ source: 'xg' }],
        });
      }
      if (st.xG !== null && st.xG <= 0.15 && st.events.goals >= 1) {
        out.push({
          type: 'FORTUNA_SFACCIATA_XG',
          subjects: [playerRef(ctx, p.playerId), teamRef(ctx, v.teamId)],
          numbers: { xG: st.xG.toFixed(2), gol: String(st.events.goals), fantavoto: fmt(p.fantaVote ?? 0, 1) },
          polarity: 'farsa',
          drama: drama(66, { intensity: 1 - st.xG / 0.15 }),
          plain: `${ctx.playerName(p.playerId)} ha segnato ${st.events.goals} gol con appena ${st.xG.toFixed(2)} xG.`,
          evidence: [{ source: 'xg' }],
        });
      }
    }
  }

  // Flop d'asta: il giocatore più caro della lega che ha reso meno.
  const rules = ctx.result.rules;
  let flopAsta: { teamId: string; playerId: string; price: number; fv: number } | null = null;
  for (const team of ctx.result.snapshot.teams) {
    for (const r of team.roster) {
      if (r.purchasePrice === null || r.purchasePrice < 20) continue;
      const st = ctx.stat(r.playerId);
      if (!st) continue;
      const fv = computeFantaVote(st, rules);
      if (fv === null || fv > 5.5) continue;
      if (!flopAsta || r.purchasePrice > flopAsta.price) {
        flopAsta = { teamId: team.teamId, playerId: r.playerId, price: r.purchasePrice, fv };
      }
    }
  }
  if (flopAsta) {
    out.push({
      type: 'FLOP_ASTA',
      subjects: [playerRef(ctx, flopAsta.playerId), teamRef(ctx, flopAsta.teamId)],
      numbers: { prezzo: String(flopAsta.price), fantavoto: fmt(flopAsta.fv, 1) },
      polarity: 'farsa',
      drama: drama(69, { intensity: intensityOf(flopAsta.price, 250) }),
      plain: `${ctx.playerName(flopAsta.playerId)}, pagato ${flopAsta.price} all'asta, ha chiuso con ${fmt(flopAsta.fv, 1)}.`,
      evidence: [{ source: 'asta' }],
    });
  }

  return out;
}
