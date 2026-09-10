import { fmt } from '@fantacomics/core';
import type { FactContext, FactDraft } from '../context.js';
import { playerRef, teamRef } from '../context.js';
import { drama, intensityOf } from '../drama.js';
import type { TeamView } from '../views.js';

/** Il modificatore difesa: spesso decide il risultato e nessuno se ne accorge. */
export function detectModifiers(ctx: FactContext, views: Map<string, TeamView>): FactDraft[] {
  const out: FactDraft[] = [];
  const cfg = ctx.result.rules.defenseModifier;
  if (!cfg.enabled) return out;

  const maxBand = cfg.bands.reduce((m, b) => Math.max(m, b.bonus), 0);

  for (const v of views.values()) {
    const mod = v.score.modifiers.defense;

    if (mod.applied && mod.bonus >= 3) {
      // Il modificatore è decisivo se toglierlo cambierebbe l'esito.
      const decisive = v.outcome !== 'L' && v.pointsMargin < mod.bonus;
      const hero = [...mod.contributors].sort((a, b) => b.vote - a.vote)[0];
      out.push({
        type: 'MODIFICATORE_SALVATORE',
        subjects: [teamRef(ctx, v.teamId), ...(hero ? [playerRef(ctx, hero.playerId)] : [])],
        numbers: {
          bonus: `+${mod.bonus}`,
          media: fmt(mod.average ?? 0, 2),
          punti: fmt(v.points, 1),
          scarto: fmt(v.pointsMargin, 1),
        },
        polarity: 'trionfo',
        drama: drama(decisive ? 83 : 58, { intensity: intensityOf(mod.bonus, maxBand) }),
        plain: decisive
          ? `Il modificatore difesa (+${mod.bonus}, media ${fmt(mod.average ?? 0, 2)}) ha deciso la partita di ${ctx.teamName(v.teamId)}.`
          : `${ctx.teamName(v.teamId)} ha incassato +${mod.bonus} di modificatore con media ${fmt(mod.average ?? 0, 2)}.`,
        evidence: [{ source: 'modificatore-difesa', detail: mod.reason }],
      });
    }

    if (!mod.applied && v.outcome !== 'W' && v.pointsMargin <= maxBand) {
      out.push({
        type: 'MODIFICATORE_MANCATO',
        subjects: [teamRef(ctx, v.teamId)],
        numbers: {
          motivo: mod.reason,
          scarto: fmt(v.pointsMargin, 1),
          bonusMassimo: `+${maxBand}`,
          punti: fmt(v.points, 1),
        },
        polarity: 'tragedia',
        drama: drama(77, { intensity: 1 - v.pointsMargin / Math.max(maxBand, 1) }),
        plain: `${ctx.teamName(v.teamId)} non ha preso il modificatore (${mod.reason}) e ha lasciato per strada un risultato deciso da ${fmt(v.pointsMargin, 1)} punti.`,
        evidence: [{ source: 'modificatore-difesa', detail: mod.reason }],
      });
    }
  }

  return out;
}
