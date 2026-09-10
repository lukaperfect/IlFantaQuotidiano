import { z } from 'zod';
import { ModuleSchema } from './snapshot.js';

/**
 * Il regolamento della lega è DATO, non codice.
 * Hardcodare il regolamento standard significa sbagliare i numeri
 * in una quota enorme di leghe e far fallire la riconciliazione a catena.
 */

export const BonusTableSchema = z.object({
  /** `goals` nello snapshot include SEMPRE i rigori segnati. */
  goal: z.number().default(3),
  ownGoal: z.number().default(-2),
  assist: z.number().default(1),
  /** Delta AGGIUNTIVO sopra `goal` per i gol su rigore. Default 0 = nessun doppio conteggio. */
  penaltyScored: z.number().default(0),
  penaltyMissed: z.number().default(-3),
  penaltySaved: z.number().default(3),
  yellowCard: z.number().default(-0.5),
  redCard: z.number().default(-1),
  /** Applicato al portiere per ogni gol subito. */
  goalConcededGK: z.number().default(-1),
  /** Bonus al portiere che non subisce gol (porta inviolata). */
  cleanSheetGK: z.number().default(1),
});
export type BonusTable = z.infer<typeof BonusTableSchema>;

/** Una fascia del modificatore: se media >= minAverage (e < della fascia successiva) => bonus. */
export const ModifierBandSchema = z.object({
  minAverage: z.number(),
  bonus: z.number(),
});
export type ModifierBand = z.infer<typeof ModifierBandSchema>;

export const DefenseModifierSchema = z.object({
  enabled: z.boolean().default(true),
  /** Il modificatore si applica solo se sono schierati almeno N difensori. */
  minDefenders: z.number().int().min(0).default(4),
  /** Quanti difensori entrano nella media (i migliori per VOTO), oltre al portiere. */
  defendersInAverage: z.number().int().min(1).default(3),
  includeGoalkeeper: z.boolean().default(true),
  /** Fasce ordinate per minAverage crescente. */
  bands: z.array(ModifierBandSchema),
});
export type DefenseModifier = z.infer<typeof DefenseModifierSchema>;

export const CaptainRuleSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['multiplier', 'bonus']).default('multiplier'),
  /** x2 sul fantavoto se mode=multiplier, oppure punti fissi se mode=bonus. */
  value: z.number().default(2),
  /** Se il capitano è SV, il vice prende il ruolo. */
  viceFallback: z.boolean().default(true),
});
export type CaptainRule = z.infer<typeof CaptainRuleSchema>;

export const SubstitutionRuleSchema = z.object({
  max: z.number().int().min(0).default(3),
  /** Se true, un SV può essere sostituito solo da un panchinaro dello stesso ruolo. */
  requireSameRole: z.boolean().default(true),
  /** Se true, un ruolo diverso è ammesso purché il modulo resti valido. */
  allowModuleChange: z.boolean().default(false),
});
export type SubstitutionRule = z.infer<typeof SubstitutionRuleSchema>;

export const GoalThresholdSchema = z.object({
  /** Punti necessari per il primo gol. */
  base: z.number().default(66),
  /** Punti per ogni gol successivo. */
  step: z.number().default(6),
});
export type GoalThreshold = z.infer<typeof GoalThresholdSchema>;

export const LeagueRulesetSchema = z.object({
  rulesetId: z.string().min(1),
  /** Ogni edizione salva questa versione: riproducibilità e debug delle contestazioni. */
  version: z.number().int().min(1),
  label: z.string().default('Classic standard'),
  bonus: BonusTableSchema,
  useAssists: z.boolean().default(true),
  defenseModifier: DefenseModifierSchema,
  midfieldModifier: DefenseModifierSchema.nullable().default(null),
  attackModifier: DefenseModifierSchema.nullable().default(null),
  captain: CaptainRuleSchema,
  goalThreshold: GoalThresholdSchema,
  /** Punti aggiunti alla squadra di casa (alcune leghe lo usano). */
  homeFieldBonus: z.number().default(0),
  substitutions: SubstitutionRuleSchema,
  allowedModules: z.array(ModuleSchema).min(1),
});
export type LeagueRuleset = z.infer<typeof LeagueRulesetSchema>;

/** I moduli ammessi dal Classic sul circuito principale. */
export const STANDARD_MODULES = [
  '3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-3-2', '5-4-1', '3-4-2', '4-2-4',
] as const;

/**
 * Ruleset di default. È una CONFIGURAZIONE, non una verità:
 * ogni lega parte da qui e l'admin la adatta al proprio regolamento.
 */
export const DEFAULT_RULESET: LeagueRuleset = LeagueRulesetSchema.parse({
  rulesetId: 'classic-standard',
  version: 1,
  label: 'Classic standard (fantacalcio.it)',
  bonus: {},
  useAssists: true,
  defenseModifier: {
    enabled: true,
    minDefenders: 4,
    defendersInAverage: 3,
    includeGoalkeeper: true,
    bands: [
      { minAverage: 6, bonus: 1 },
      { minAverage: 6.5, bonus: 3 },
      { minAverage: 7, bonus: 4 },
      { minAverage: 7.5, bonus: 6 },
    ],
  },
  captain: { enabled: false },
  goalThreshold: { base: 66, step: 6 },
  homeFieldBonus: 0,
  substitutions: { max: 3, requireSameRole: true, allowModuleChange: false },
  allowedModules: [...STANDARD_MODULES],
});

/** Scompone "3-4-3" in {defenders:3, midfielders:4, forwards:3}. */
export function parseModule(module: string): { defenders: number; midfielders: number; forwards: number } {
  const parts = module.split('-').map((p) => Number.parseInt(p, 10));
  const [d, m, f] = parts;
  if (parts.length !== 3 || d === undefined || m === undefined || f === undefined) {
    throw new Error(`Modulo non valido: ${module}`);
  }
  if (d + m + f !== 10) {
    throw new Error(`Modulo ${module}: i giocatori di movimento devono essere 10, sono ${d + m + f}`);
  }
  return { defenders: d, midfielders: m, forwards: f };
}
