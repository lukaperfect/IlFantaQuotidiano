import type { NarrativeFact, Slot } from '@fantacomics/core';
import { seededRandom } from '@fantacomics/core';
import { FORMAT_DECK, type FormatCard } from './formats.js';
import { PERSONAS, type Persona } from './personas.js';
import type { EditorialMemory } from './memory.js';

export type SpiceLevel = 1 | 2 | 3;

export type PlannedArticle = {
  slot: Slot;
  format: FormatCard;
  persona: Persona;
  facts: NarrativeFact[];
  teamIds: string[];
};

export type PersonalCard = {
  teamId: string;
  fact: NarrativeFact;
  tone: 'gloria' | 'disfatta' | 'grigiore';
};

export type EditorialPlan = {
  seed: string;
  articles: PlannedArticle[];
  personalCards: PersonalCard[];
  coverage: { teamId: string; appearances: number; hasGlory: boolean }[];
  warnings: string[];
};

export type SelectionInput = {
  facts: readonly NarrativeFact[];
  teamIds: readonly string[];
  matchday: number;
  leagueId: string;
  memory: EditorialMemory;
  spice?: SpiceLevel;
  targetArticles?: number;
};

const NEGATIVE = new Set(['tragedia', 'farsa']);

/** Quanti bersagli negativi tollera un presidente, per livello di piccante. */
const SPICE_CAP: Record<SpiceLevel, number> = { 1: 1, 2: 2, 3: 4 };

/** L'impaginato: quali slot esistono e in che ordine. */
function slotPlan(target: number): Slot[] {
  const plan: Slot[] = ['apertura', 'spalla', 'taglio_basso'];
  const interni = Math.max(1, Math.min(5, target - 5));
  for (let i = 0; i < interni; i++) plan.push('interno');
  plan.push('rubrica', 'rubrica');
  return plan.slice(0, Math.max(3, target));
}

function teamsOf(fact: NarrativeFact): string[] {
  return fact.subjects.filter((s) => s.kind === 'team').map((s) => s.id);
}

/**
 * Il PROTAGONISTA del fatto: la prima squadra citata.
 * Le successive sono comprimari (tipicamente l'avversario), e un fatto in cui
 * compari come comprimario NON racconta la tua storia.
 */
function protagonistOf(fact: NarrativeFact): string | undefined {
  return fact.subjects.find((s) => s.kind === 'team')?.id;
}

/**
 * Il punteggio editoriale.
 *
 *   score = drama
 *         - penalità_ripetizione   (tipo già usato di recente)
 *         - penalità_concentrazione(soggetto già coperto in questa edizione)
 *         - penalità_sfottò        (presidente già bersagliato troppo)
 *         + bonus_copertura        (presidente assente da troppe giornate)
 *
 * Il termine di copertura è quello a cui nessuno pensa e che decide la
 * retention: il divertimento collettivo richiede che tutti siano nel gioco.
 */
function scoreFact(
  fact: NarrativeFact,
  input: SelectionInput,
  chosenCount: Map<string, number>,
): number {
  const { memory, matchday } = input;
  let score = fact.drama;

  const lastUse = memory.lastFactTypeUse[fact.type];
  if (lastUse !== undefined) {
    const age = matchday - lastUse;
    score -= 28 * Math.max(0, 1 - age / 4);
  }

  const teams = teamsOf(fact);
  const concentration = teams.reduce((m, t) => Math.max(m, chosenCount.get(t) ?? 0), 0);
  score -= 30 * Math.min(1, concentration / 2);

  let coverage = 0;
  for (const t of teams) {
    const last = memory.lastAppearance[t];
    const age = last === undefined ? 4 : matchday - last;
    coverage = Math.max(coverage, Math.min(1, age / 3));
  }
  score += 22 * coverage;

  if (NEGATIVE.has(fact.polarity)) {
    const cap = SPICE_CAP[input.spice ?? 2];
    const targeted = teams.reduce((m, t) => Math.max(m, memory.recentTargetCount[t] ?? 0), 0);
    if (targeted >= cap) score -= 45;
  }

  return score;
}

/** Selezione greedy con rendimenti decrescenti: ogni scelta cambia il punteggio delle successive. */
function selectFacts(input: SelectionInput, howMany: number): NarrativeFact[] {
  const remaining = [...input.facts];
  const chosen: NarrativeFact[] = [];
  const chosenCount = new Map<string, number>();

  while (chosen.length < howMany && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const fact = remaining[i];
      if (!fact) continue;
      const s = scoreFact(fact, input, chosenCount);
      // Tie-break deterministico sull'id: stesso input, stesso giornale.
      if (s > bestScore || (s === bestScore && bestIdx >= 0 && fact.id < (remaining[bestIdx]?.id ?? ''))) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const picked = remaining.splice(bestIdx, 1)[0];
    if (!picked) break;
    chosen.push(picked);
    for (const t of teamsOf(picked)) chosenCount.set(t, (chosenCount.get(t) ?? 0) + 1);
  }
  return chosen;
}

/**
 * Vincoli duri applicati DOPO il greedy.
 * Il greedy massimizza il drama; questi garantiscono che il giornale resti
 * un prodotto per tutta la lega e non per i tre presidenti più sfortunati.
 */
function enforceConstraints(
  selected: NarrativeFact[],
  input: SelectionInput,
  warnings: string[],
): NarrativeFact[] {
  const chosen = new Set(selected.map((f) => f.id));
  /**
   * I fatti aggiunti per soddisfare un vincolo duro sono ESENTI dal tetto
   * agli sfotto': sono li' per garantire copertura o gloria, non per colpire.
   * Restano in coda, quindi finiscono nelle pagine interne e non in apertura.
   */
  const forced: NarrativeFact[] = [];
  const covered = new Set(selected.flatMap(teamsOf));

  // 1. Copertura: nessuno resta invisibile due giornate di fila.
  for (const teamId of input.teamIds) {
    if (covered.has(teamId)) continue;
    const last = input.memory.lastAppearance[teamId];
    const absent = last === undefined ? 99 : input.matchday - last;
    if (absent < 2) continue;

    const candidate = input.facts.find((f) => !chosen.has(f.id) && teamsOf(f).includes(teamId));
    if (candidate) {
      forced.push(candidate);
      chosen.add(candidate.id);
      covered.add(teamId);
    } else {
      warnings.push(`Nessun fatto disponibile per ${teamId}: copertura non garantita.`);
    }
  }

  // 2. Gloria: ogni presidente ha diritto a un momento positivo ogni tanto.
  for (const teamId of input.teamIds) {
    const lastGlory = input.memory.lastGlory[teamId];
    const dry = lastGlory === undefined ? 99 : input.matchday - lastGlory;
    if (dry < 4) continue;
    const alreadyPositive = [...selected, ...forced].some(
      (f) => teamsOf(f).includes(teamId) && !NEGATIVE.has(f.polarity),
    );
    if (alreadyPositive) continue;

    const positive = input.facts.find(
      (f) => !chosen.has(f.id) && teamsOf(f).includes(teamId) && !NEGATIVE.has(f.polarity),
    );
    if (positive) {
      forced.push(positive);
      chosen.add(positive.id);
    }
  }

  /**
   * 3. Tetto agli sfotto'. Si scorre nell'ORDINE EDITORIALE, non per drama
   * grezzo: quell'ordine incorpora gia' anti-ripetizione e copertura, e
   * ri-ordinarlo qui le annullerebbe entrambe in silenzio.
   */
  const cap = SPICE_CAP[input.spice ?? 2];
  const negCount = new Map<string, number>();
  const kept: NarrativeFact[] = [];
  for (const fact of selected) {
    if (NEGATIVE.has(fact.polarity)) {
      const teams = teamsOf(fact);
      if (teams.some((t) => (negCount.get(t) ?? 0) >= cap)) continue;
      for (const t of teams) negCount.set(t, (negCount.get(t) ?? 0) + 1);
    }
    kept.push(fact);
  }

  return [...kept, ...forced];
}

function pickFormat(
  slot: Slot,
  anchor: NarrativeFact,
  input: SelectionInput,
  usedInEdition: Set<string>,
  rnd: () => number,
  warnings: string[],
): FormatCard {
  const eligible = FORMAT_DECK.filter((f) => {
    if (!f.slots.includes(slot)) return false;
    if (usedInEdition.has(f.id)) return false;
    if (!f.polarities.includes(anchor.polarity)) return false;
    const last = input.memory.lastFormatUse[f.id];
    return last === undefined || input.matchday - last >= f.cooldown;
  });

  // Meglio riusare un format che non produrre il pezzo — ma il ripiego non
  // deve avvenire in silenzio: e' il primo sintomo di un mazzo troppo corto.
  let pool = eligible;
  if (pool.length === 0) {
    pool = FORMAT_DECK.filter((f) => f.slots.includes(slot) && !usedInEdition.has(f.id));
    warnings.push(`Slot ${slot}: nessun format disponibile senza forzare cooldown o polarita'.`);
  }
  if (pool.length === 0) {
    warnings.push(`Slot ${slot}: mazzo esaurito, format riusato nella stessa edizione.`);
    return FORMAT_DECK[0] as FormatCard;
  }

  // Si preferisce il format fermo da più tempo: rotazione, non casualità.
  const scored = pool.map((f) => ({
    f,
    age: input.memory.lastFormatUse[f.id] === undefined
      ? 999
      : input.matchday - (input.memory.lastFormatUse[f.id] as number),
  }));
  const maxAge = Math.max(...scored.map((s) => s.age));
  const freshest = scored.filter((s) => s.age >= maxAge * 0.6);
  const chosen = freshest[Math.floor(rnd() * freshest.length)] ?? scored[0];
  return (chosen as { f: FormatCard }).f;
}

function pickPersona(
  input: SelectionInput,
  usedInEdition: Set<string>,
  rnd: () => number,
): Persona {
  const pool = PERSONAS.filter((p) => !usedInEdition.has(p.id));
  const candidates = pool.length > 0 ? pool : PERSONAS;
  const scored = candidates.map((p) => ({
    p,
    age: input.memory.lastPersonaUse[p.id] === undefined
      ? 999
      : input.matchday - (input.memory.lastPersonaUse[p.id] as number),
  }));
  const maxAge = Math.max(...scored.map((s) => s.age));
  const freshest = scored.filter((s) => s.age >= maxAge * 0.6);
  return (freshest[Math.floor(rnd() * freshest.length)] ?? scored[0] as { p: Persona }).p;
}

/** Costruisce il piano editoriale completo di una giornata. */
export function planEdition(input: SelectionInput): EditorialPlan {
  const warnings: string[] = [];
  const target = input.targetArticles ?? 8;
  const slots = slotPlan(target);
  const seed = `${input.leagueId}:${input.matchday}`;
  const rnd = seededRandom(seed);

  const wanted = Math.min(input.facts.length, Math.max(slots.length * 2, 14));
  const selected = enforceConstraints(selectFacts(input, wanted), input, warnings);

  const pool = [...selected];
  const articles: PlannedArticle[] = [];
  const usedFormats = new Set<string>();
  const usedPersonas = new Set<string>();

  /**
   * Una squadra puo' ancorare UN solo pezzo per edizione.
   * Senza questo vincolo lo stesso presidente si prende due titoli nella
   * stessa pagina e il giornale sembra scritto male, anche quando i due
   * fatti sono diversi.
   */
  const anchored = new Set<string>();

  const usedFactIds = new Set<string>();
  const cap = SPICE_CAP[input.spice ?? 2];
  /** Conteggio dei fatti negativi gia' finiti in pagina, per squadra. */
  const negInPage = new Map<string, number>();
  const noteNegatives = (fact: NarrativeFact) => {
    if (!NEGATIVE.has(fact.polarity)) return;
    for (const t of teamsOf(fact)) negInPage.set(t, (negInPage.get(t) ?? 0) + 1);
  };
  const withinCap = (fact: NarrativeFact) =>
    !NEGATIVE.has(fact.polarity) ||
    teamsOf(fact).every((t) => (negInPage.get(t) ?? 0) < cap);

  const isFresh = (f: NarrativeFact) => {
    const p = protagonistOf(f);
    return p === undefined || !anchored.has(p);
  };

  for (const slot of slots) {
    let anchor: NarrativeFact | undefined;

    const idx = pool.findIndex(isFresh);
    if (idx >= 0) {
      anchor = pool.splice(idx, 1)[0];
    } else {
      /**
       * I fatti di una squadra possono essere gia' stati consumati come
       * materiale di corredo di un altro pezzo. Prima di rassegnarsi a far
       * aprire due pezzi allo stesso presidente si ripesca dall'elenco
       * completo: meglio un fatto meno drammatico ma di un'altra squadra.
       */
      // Il ripiego NON puo' scavalcare il tetto agli sfotto': ripescare a mano
      // un fatto bypassando il vincolo lo renderebbe inefficace proprio nei
      // casi in cui serve di piu'.
      anchor = input.facts.find((f) => !usedFactIds.has(f.id) && isFresh(f) && withinCap(f));
      if (!anchor) anchor = pool.shift();
    }
    if (!anchor) break;

    usedFactIds.add(anchor.id);
    noteNegatives(anchor);
    const poolIdx = pool.indexOf(anchor);
    if (poolIdx >= 0) pool.splice(poolIdx, 1);
    const protagonist = protagonistOf(anchor);
    if (protagonist) anchored.add(protagonist);

    const format = pickFormat(slot, anchor, input, usedFormats, rnd, warnings);
    usedFormats.add(format.id);
    const persona = pickPersona(input, usedPersonas, rnd);
    usedPersonas.add(persona.id);

    const anchorTeams = new Set(teamsOf(anchor));
    // Le rubriche vogliono AMPIEZZA (una riga per presidente), i pezzi
    // vogliono PROFONDITA' (più fatti sulla stessa storia).
    const breadth = slot === 'rubrica' || format.minFacts >= 3;
    const extras: NarrativeFact[] = [];
    const seenTeams = new Set(anchorTeams);

    for (let i = 0; i < pool.length && extras.length < format.maxFacts - 1; i++) {
      const cand = pool[i];
      if (!cand) continue;
      const candTeams = teamsOf(cand);
      const overlaps = candTeams.some((t) => anchorTeams.has(t));
      const isNew = candTeams.some((t) => !seenTeams.has(t));
      if (breadth ? isNew : overlaps) {
        extras.push(cand);
        for (const t of candTeams) seenTeams.add(t);
      }
    }
    for (const e of extras) {
      const i = pool.indexOf(e);
      if (i >= 0) pool.splice(i, 1);
      usedFactIds.add(e.id);
      noteNegatives(e);
    }

    const facts = [anchor, ...extras];
    if (facts.length < format.minFacts) {
      while (facts.length < format.minFacts && pool.length > 0) {
        const filler = pool.shift();
        if (filler) { facts.push(filler); usedFactIds.add(filler.id); noteNegatives(filler); }
      }
    }

    articles.push({
      slot,
      format,
      persona,
      facts,
      teamIds: [...new Set(facts.flatMap(teamsOf))],
    });
  }

  // Una card personale per presidente: è ciò che moltiplica la condivisione.
  const personalCards: PersonalCard[] = [];
  for (const teamId of input.teamIds) {
    const byDrama = (a: NarrativeFact, b: NarrativeFact) => b.drama - a.drama;
    /**
     * La card personale deve raccontare la storia DI QUEL presidente.
     * Prendere il fatto con piu' drama che lo "menziona" produce card in cui
     * compare come avversario di qualcun altro: il contrario di personale.
     */
    const own =
      input.facts.filter((f) => protagonistOf(f) === teamId).sort(byDrama)[0] ??
      input.facts.filter((f) => teamsOf(f).includes(teamId)).sort(byDrama)[0];
    if (!own) {
      warnings.push(`Nessuna card personale per ${teamId}.`);
      continue;
    }
    personalCards.push({
      teamId,
      fact: own,
      tone:
        own.polarity === 'trionfo' ? 'gloria'
        : own.polarity === 'mediocrita' ? 'grigiore'
        : 'disfatta',
    });
  }

  const usedTeams = articles.flatMap((a) => a.teamIds);
  const coverage = input.teamIds.map((teamId) => ({
    teamId,
    appearances: usedTeams.filter((t) => t === teamId).length,
    hasGlory: articles.some((a) =>
      a.facts.some((f) => teamsOf(f).includes(teamId) && !NEGATIVE.has(f.polarity)),
    ),
  }));

  return { seed, articles, personalCards, coverage, warnings };
}
