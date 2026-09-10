import { z } from 'zod';

/**
 * Un NarrativeFact è un fatto DETERMINISTICO, già calcolato e già formattato.
 * L'LLM non calcola: incolla. È questo che rende impossibile allucinare un numero.
 */

export const FactTypeSchema = z.enum([
  // --- Fortuna e ingiustizia (il girone virtuale di giornata) ---
  'SFIGA_CERTIFICATA',
  'CULO_CERTIFICATO',
  'MIGLIOR_PUNTEGGIO_SCONFITTO',
  'PEGGIOR_PUNTEGGIO_VINCENTE',
  'INGIUSTIZIA_STAGIONALE',
  // --- Soglie e decimi ---
  'BEFFA_DECIMALE',
  'SOGLIA_GOL_SFIORATA',
  'SOGLIA_GOL_AGGUANTATA',
  'COLPEVOLE_DEL_DECIMO',
  // --- Rimpianto scomposto ---
  'REGRET_TOTALE',
  'PANCHINA_D_ORO',
  'REGRET_MODULO',
  'REGRET_CAPITANO',
  'PANCHINARO_DECISIVO',
  // --- Efficienza e disciplina di gestione ---
  'EFFICIENZA_MASSIMA',
  'EFFICIENZA_MINIMA',
  'FORMAZIONE_NON_SCHIERATA',
  'SOSTITUZIONI_ESAURITE',
  'PIOGGIA_DI_SV',
  // --- Prestazioni individuali ---
  'TOP_GIORNATA',
  'FLOP_GIORNATA',
  'MIGLIOR_GIOCATORE_LEGA',
  'PEGGIOR_GIOCATORE_LEGA',
  'DISASTRO_PORTIERE',
  'PORTA_INVIOLATA',
  'ESPULSIONE_PESANTE',
  // --- Modificatore ---
  'MODIFICATORE_SALVATORE',
  'MODIFICATORE_MANCATO',
  // --- xG: sotto e sovra-performance ---
  'CECCHINO_SENZA_MIRA',
  'FORTUNA_SFACCIATA_XG',
  // --- Rarità storica ---
  'RECORD_POSITIVO_LEGA',
  'RECORD_NEGATIVO_LEGA',
  'PUNTEGGIO_RARO',
  // --- Archi narrativi di stagione ---
  'FILOTTO_VITTORIE',
  'CROLLO_VERTICALE',
  'SORPASSO_CLASSIFICA',
  'NUOVO_LEADER',
  'MALEDIZIONE_H2H',
  // --- Mercato ---
  'FLOP_ASTA',
  // --- Forma del match ---
  'GOLEADA',
  'PAREGGIO_NOIOSO',
]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const PolaritySchema = z.enum([
  'trionfo',
  'tragedia',
  'farsa',
  'ingiustizia',
  'mediocrita',
]);
export type Polarity = z.infer<typeof PolaritySchema>;

export const EntityRefSchema = z.object({
  kind: z.enum(['team', 'player', 'league']),
  id: z.string().min(1),
  /** Nome già sanitizzato: mai testo utente grezzo nel prompt. */
  display: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const DataRefSchema = z.object({
  source: z.string().min(1),
  detail: z.string().default(''),
});
export type DataRef = z.infer<typeof DataRefSchema>;

export const NarrativeFactSchema = z.object({
  /** Stabile e deterministico: alimenta dedup, cooldown e memoria anti-ripetizione. */
  id: z.string().min(1),
  type: FactTypeSchema,
  matchday: z.number().int().min(1).max(38),
  subjects: z.array(EntityRefSchema).min(1),
  /**
   * Numeri GIÀ FORMATTATI come stringhe: "71.5", "-0.5", "3°".
   * L'LLM non deve arrotondare, convertire o sommare nulla.
   */
  numbers: z.record(z.string(), z.string()),
  polarity: PolaritySchema,
  /** 0-100. Deriva dalla rarità, non dal gusto. */
  drama: z.number().min(0).max(100),
  /** Percentile della rarità rispetto a lega + corpus cross-lega. */
  rarityPercentile: z.number().min(0).max(100).nullable().default(null),
  /** Frase secca che riassume il fatto: fallback se l'LLM non è disponibile. */
  plain: z.string().min(1),
  evidence: z.array(DataRefSchema).default([]),
});
export type NarrativeFact = z.infer<typeof NarrativeFactSchema>;

/** Il pacchetto che viene passato all'LLM: fatti + anagrafica minima, nient'altro. */
export const FactPackSchema = z.object({
  leagueId: z.string().min(1),
  leagueName: z.string().min(1),
  matchday: z.number().int().min(1).max(38),
  season: z.string(),
  factEngineVersion: z.string().min(1),
  facts: z.array(NarrativeFactSchema),
  /** Risultati della giornata, per il tabellino. */
  results: z.array(z.object({
    homeTeam: z.string(),
    awayTeam: z.string(),
    homePoints: z.string(),
    awayPoints: z.string(),
    homeGoals: z.string(),
    awayGoals: z.string(),
  })),
  standings: z.array(z.object({
    position: z.string(),
    teamName: z.string(),
    points: z.string(),
  })),
});
export type FactPack = z.infer<typeof FactPackSchema>;
