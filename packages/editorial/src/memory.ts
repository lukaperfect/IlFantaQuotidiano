/**
 * La memoria editoriale della lega.
 * È ciò che impedisce al giornale di ripetersi e, soprattutto, ciò che
 * garantisce che nessun presidente venga dimenticato: se un utente non
 * appare mai nel giornale, smette di leggerlo.
 */
export type EditorialMemory = {
  /** factType -> ultima giornata in cui è stato usato. */
  lastFactTypeUse: Record<string, number>;
  /** formatId -> ultima giornata. */
  lastFormatUse: Record<string, number>;
  /** personaId -> ultima giornata. */
  lastPersonaUse: Record<string, number>;
  /** teamId -> ultima giornata in cui la squadra è comparsa. */
  lastAppearance: Record<string, number>;
  /** teamId -> ultima giornata in cui è comparsa in luce POSITIVA. */
  lastGlory: Record<string, number>;
  /** teamId -> quante volte è stata bersaglio nella finestra recente. */
  recentTargetCount: Record<string, number>;
};

export function emptyMemory(): EditorialMemory {
  return {
    lastFactTypeUse: {},
    lastFormatUse: {},
    lastPersonaUse: {},
    lastAppearance: {},
    lastGlory: {},
    recentTargetCount: {},
  };
}

const NEGATIVE = new Set(['tragedia', 'farsa']);

export type MemoryUpdate = {
  matchday: number;
  factTypes: string[];
  formatIds: string[];
  personaIds: string[];
  /** teamId -> polarità con cui è comparso in questa edizione. */
  appearances: Record<string, string[]>;
};

/** Avanza la memoria di una giornata. Pura: nessuno stato nascosto. */
export function updateMemory(memory: EditorialMemory, update: MemoryUpdate): EditorialMemory {
  const next: EditorialMemory = {
    lastFactTypeUse: { ...memory.lastFactTypeUse },
    lastFormatUse: { ...memory.lastFormatUse },
    lastPersonaUse: { ...memory.lastPersonaUse },
    lastAppearance: { ...memory.lastAppearance },
    lastGlory: { ...memory.lastGlory },
    recentTargetCount: { ...memory.recentTargetCount },
  };

  for (const t of update.factTypes) next.lastFactTypeUse[t] = update.matchday;
  for (const f of update.formatIds) next.lastFormatUse[f] = update.matchday;
  for (const p of update.personaIds) next.lastPersonaUse[p] = update.matchday;

  for (const [teamId, polarities] of Object.entries(update.appearances)) {
    next.lastAppearance[teamId] = update.matchday;
    if (polarities.some((p) => !NEGATIVE.has(p))) next.lastGlory[teamId] = update.matchday;

    const negatives = polarities.filter((p) => NEGATIVE.has(p)).length;
    // Decadimento: il conteggio dei bersagli si sgonfia se non si viene colpiti.
    const prior = next.recentTargetCount[teamId] ?? 0;
    next.recentTargetCount[teamId] = Math.max(0, prior - 1) + negatives;
  }

  return next;
}
