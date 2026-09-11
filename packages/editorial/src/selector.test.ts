import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET, type NarrativeFact } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { generateFacts } from '@fantacomics/facts';
import { generateWorld, withOfficialScores, nudgeTeamToScore } from '@fantacomics/ingest';
import { planEdition, type SelectionInput } from './selector.js';
import { emptyMemory, updateMemory, type EditorialMemory } from './memory.js';
import { FORMAT_DECK } from './formats.js';

const R = DEFAULT_RULESET;

function facts(matchday = 12): { facts: NarrativeFact[]; teamIds: string[] } {
  let world = generateWorld({ seed: 'editoriale', teams: 8, matchday, scenarios: { formazioneNonSchierata: true } });
  world = nudgeTeamToScore(world, 't1', 71.5, R);
  world = withOfficialScores(world, R);
  const result = computeLeagueMatchday(world.snapshot, world.serieA, R);
  return {
    facts: generateFacts(result).facts,
    teamIds: world.snapshot.teams.map((t) => t.teamId),
  };
}

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  const base = facts();
  return {
    facts: base.facts,
    teamIds: base.teamIds,
    matchday: 12,
    leagueId: 'lega-test',
    memory: emptyMemory(),
    spice: 2,
    targetArticles: 8,
    ...over,
  };
}

describe('selector editoriale', () => {
  it('è deterministico a parità di input', () => {
    const a = planEdition(input());
    const b = planEdition(input());
    expect(a.articles.map((x) => `${x.slot}/${x.format.id}/${x.persona.id}`))
      .toEqual(b.articles.map((x) => `${x.slot}/${x.format.id}/${x.persona.id}`));
    expect(a.articles.flatMap((x) => x.facts.map((f) => f.id)))
      .toEqual(b.articles.flatMap((x) => x.facts.map((f) => f.id)));
  });

  it('produce un giornale completo con apertura, spalla e rubriche', () => {
    const plan = planEdition(input());
    const slots = plan.articles.map((a) => a.slot);
    expect(slots[0]).toBe('apertura');
    expect(slots).toContain('spalla');
    expect(slots).toContain('rubrica');
    expect(plan.articles.length).toBeGreaterThanOrEqual(6);
    for (const a of plan.articles) expect(a.facts.length).toBeGreaterThan(0);
  });

  it('copre ogni presidente della lega', () => {
    const plan = planEdition(input());
    const uncovered = plan.coverage.filter((c) => c.appearances === 0);
    expect(uncovered, `scoperti: ${uncovered.map((c) => c.teamId).join(',')}`).toHaveLength(0);
  });

  it('emette una card personale per ogni squadra', () => {
    const base = facts();
    const plan = planEdition(input());
    expect(plan.personalCards).toHaveLength(base.teamIds.length);
    expect(new Set(plan.personalCards.map((c) => c.teamId)).size).toBe(base.teamIds.length);
  });

  it('non ripete un format o una voce dentro la stessa edizione', () => {
    const plan = planEdition(input());
    const formats = plan.articles.map((a) => a.format.id);
    const personas = plan.articles.map((a) => a.persona.id);
    expect(new Set(formats).size).toBe(formats.length);
    // Le voci sono 6: oltre quel numero la ripetizione è inevitabile.
    expect(new Set(personas).size).toBe(Math.min(personas.length, 6));
  });

  it('usa solo format compatibili con lo slot e con la polarità del pezzo', () => {
    const plan = planEdition(input());
    for (const a of plan.articles) {
      expect(a.format.slots).toContain(a.slot);
      const anchor = a.facts[0];
      expect(anchor).toBeDefined();
      expect(a.format.polarities).toContain((anchor as NarrativeFact).polarity);
    }
  });

  it('rispetta il cooldown quando il mazzo offre alternative', () => {
    // Stato realistico: il mazzo e' stato consumato con recency variabile
    // nelle giornate precedenti, non tutto in blocco alla giornata scorsa.
    const memory = emptyMemory();
    FORMAT_DECK.forEach((f, i) => { memory.lastFormatUse[f.id] = 12 - (i % 9) - 1; });

    const plan = planEdition(input({ memory }));
    const violazioni = plan.articles.filter((a) => {
      const last = memory.lastFormatUse[a.format.id];
      return last !== undefined && 12 - last < a.format.cooldown;
    });
    expect(violazioni.map((v) => v.format.id)).toEqual([]);
    expect(plan.warnings.filter((w) => w.includes('cooldown'))).toEqual([]);
  });

  it('segnala quando è costretto a forzare il cooldown', () => {
    // Mazzo bruciato in blocco: il ripiego deve essere visibile, non silenzioso.
    const memory = emptyMemory();
    for (const f of FORMAT_DECK) memory.lastFormatUse[f.id] = 12;
    const plan = planEdition(input({ memory }));
    expect(plan.warnings.some((w) => w.includes('cooldown'))).toBe(true);
    expect(plan.articles.length).toBeGreaterThan(0); // il giornale esce comunque
  });

  it('penalizza i tipi di fatto usati nella giornata precedente', () => {
    // Unit test del meccanismo su fatti costruiti: con drama vicini, la
    // penalita' di ripetizione deve invertire l'ordine.
    const mk = (id: string, type: NarrativeFact['type'], drama: number): NarrativeFact => ({
      id, type, matchday: 12, drama, polarity: 'tragedia', rarityPercentile: null,
      subjects: [{ kind: 'team', id: 't1', display: 'T1' }],
      numbers: { x: '1' }, plain: id, evidence: [],
    });
    const due = [mk('a', 'SFIGA_CERTIFICATA', 80), mk('b', 'REGRET_TOTALE', 78)];

    const senza = planEdition(input({ facts: due, teamIds: ['t1'], targetArticles: 3 }));
    expect(senza.articles[0]?.facts[0]?.id).toBe('a');

    const memory = emptyMemory();
    memory.lastFactTypeUse.SFIGA_CERTIFICATA = 11; // usato la giornata scorsa
    const con = planEdition(input({ facts: due, teamIds: ['t1'], targetArticles: 3, memory }));
    expect(con.articles[0]?.facts[0]?.id).toBe('b');
  });

  it('non lascia che la penalità di ripetizione sotterri un fatto eccezionale', () => {
    const mk = (id: string, type: NarrativeFact['type'], drama: number): NarrativeFact => ({
      id, type, matchday: 12, drama, polarity: 'tragedia', rarityPercentile: null,
      subjects: [{ kind: 'team', id: 't1', display: 'T1' }],
      numbers: { x: '1' }, plain: id, evidence: [],
    });
    const due = [mk('a', 'SFIGA_CERTIFICATA', 98), mk('b', 'REGRET_TOTALE', 40)];
    const memory = emptyMemory();
    memory.lastFactTypeUse.SFIGA_CERTIFICATA = 11;
    const plan = planEdition(input({ facts: due, teamIds: ['t1'], targetArticles: 3, memory }));
    // 98 - 21 di penalita' resta sopra 40: la notizia grossa vince comunque.
    expect(plan.articles[0]?.facts[0]?.id).toBe('a');
  });

  it('premia chi è assente da troppe giornate', () => {
    const base = facts();
    const dimenticato = base.teamIds[base.teamIds.length - 1] as string;
    const memory = emptyMemory();
    for (const t of base.teamIds) memory.lastAppearance[t] = 11;
    memory.lastAppearance[dimenticato] = 5; // fermo da 7 giornate

    const plan = planEdition(input({ memory }));
    const cov = plan.coverage.find((c) => c.teamId === dimenticato);
    expect(cov?.appearances).toBeGreaterThan(0);
  });

  it('applica il tetto agli sfottò secondo il livello di piccante', () => {
    const base = facts();
    for (const spice of [1, 2, 3] as const) {
      const plan = planEdition(input({ spice }));
      const cap = { 1: 1, 2: 2, 3: 4 }[spice];
      for (const teamId of base.teamIds) {
        const negativi = plan.articles
          .flatMap((a) => a.facts)
          .filter((f) => ['tragedia', 'farsa'].includes(f.polarity))
          .filter((f) => f.subjects.some((s) => s.kind === 'team' && s.id === teamId));
        expect(new Set(negativi.map((f) => f.id)).size,
          `spice ${spice}, squadra ${teamId}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('con piccante basso produce meno sfottò che con piccante alto', () => {
    const negativi = (spice: 1 | 2 | 3) =>
      planEdition(input({ spice })).articles
        .flatMap((a) => a.facts)
        .filter((f) => ['tragedia', 'farsa'].includes(f.polarity)).length;
    expect(negativi(1)).toBeLessThanOrEqual(negativi(3));
  });
});

describe('memoria editoriale', () => {
  it('registra apparizioni, gloria e bersagli', () => {
    const m = updateMemory(emptyMemory(), {
      matchday: 12,
      factTypes: ['SFIGA_CERTIFICATA'],
      formatIds: ['necrologio'],
      personaIds: ['nostalgico'],
      appearances: { t1: ['tragedia', 'trionfo'], t2: ['farsa'] },
    });
    expect(m.lastFactTypeUse.SFIGA_CERTIFICATA).toBe(12);
    expect(m.lastFormatUse.necrologio).toBe(12);
    expect(m.lastAppearance.t1).toBe(12);
    expect(m.lastGlory.t1).toBe(12);     // ha avuto anche un momento positivo
    expect(m.lastGlory.t2).toBeUndefined(); // solo bastonate
    expect(m.recentTargetCount.t2).toBe(1);
  });

  it('sgonfia il conteggio dei bersagli quando non si viene colpiti', () => {
    let m = emptyMemory();
    m.recentTargetCount.t3 = 3;
    m = updateMemory(m, {
      matchday: 12, factTypes: [], formatIds: [], personaIds: [],
      appearances: { t3: ['trionfo'] },
    });
    expect(m.recentTargetCount.t3).toBe(2);
  });

  it('garantisce un momento di gloria a chi è a secco da troppo', () => {
    const base = facts();
    const memory = emptyMemory();
    for (const t of base.teamIds) {
      memory.lastAppearance[t] = 11;
      memory.lastGlory[t] = 2; // nessuna gloria da 10 giornate
    }
    const plan = planEdition(input({ memory }));
    const conGloria = plan.coverage.filter((c) => c.hasGlory).length;
    expect(conGloria).toBeGreaterThanOrEqual(Math.ceil(base.teamIds.length / 2));
  });
});

describe('card personali', () => {
  it('racconta la storia del destinatario, non quella del suo avversario', () => {
    const base = facts();
    const plan = planEdition(input());
    for (const card of plan.personalCards) {
      const protagonista = card.fact.subjects.find((s) => s.kind === 'team')?.id;
      expect(protagonista, `card di ${card.teamId} intestata a ${protagonista}`).toBe(card.teamId);
    }
    expect(plan.personalCards).toHaveLength(base.teamIds.length);
  });

  it('assegna il tono coerente con la polarità del fatto', () => {
    const plan = planEdition(input());
    for (const card of plan.personalCards) {
      if (card.fact.polarity === 'trionfo') expect(card.tone).toBe('gloria');
      else if (card.fact.polarity === 'mediocrita') expect(card.tone).toBe('grigiore');
      else expect(card.tone).toBe('disfatta');
    }
  });
});

describe('impaginazione', () => {
  it('non lascia che la stessa squadra apra due pezzi', () => {
    const plan = planEdition(input());
    const protagonisti = plan.articles
      .map((a) => a.facts[0]?.subjects.find((s) => s.kind === 'team')?.id)
      .filter((id): id is string => id !== undefined);
    expect(new Set(protagonisti).size).toBe(protagonisti.length);
  });

  it('riempie comunque lo slot se restano solo squadre già in apertura', () => {
    // Un solo soggetto disponibile: la ripetizione è preferibile allo slot vuoto.
    const mk = (id: string, drama: number): NarrativeFact => ({
      id, type: 'REGRET_TOTALE', matchday: 12, drama, polarity: 'tragedia', rarityPercentile: null,
      subjects: [{ kind: 'team', id: 't1', display: 'T1' }],
      numbers: { punti: '60' }, plain: `Fatto ${id}`, evidence: [],
    });
    const plan = planEdition(input({
      facts: [mk('a', 80), mk('b', 70), mk('c', 60)], teamIds: ['t1'], targetArticles: 3,
    }));
    expect(plan.articles.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * L'edizione di vigilia
 * ------------------------------------------------------------------ */

describe('il mazzo dei format dipende dal tipo di edizione', () => {
  /** Un fatto d'asta: esiste alla vigilia e non parla di nessuna partita. */
  const fattoAsta = (i: number): NarrativeFact => ({
    id: `asta-${i}`,
    type: 'PEZZO_PREGIATO',
    matchday: 1,
    subjects: [{ kind: 'team', id: `t${i}`, display: `Squadra ${i}` }],
    numbers: { prezzo: String(100 + i) },
    polarity: 'mediocrita',
    drama: 40 - i,
    rarityPercentile: null,
    plain: `La squadra ${i} ha pagato ${100 + i}.`,
    evidence: [],
  });

  const vigilia = (over: Partial<SelectionInput> = {}): SelectionInput => ({
    facts: Array.from({ length: 14 }, (_, i) => fattoAsta(i)),
    teamIds: Array.from({ length: 10 }, (_, i) => `t${i}`),
    matchday: 1,
    leagueId: 'lega-vigilia',
    memory: emptyMemory(),
    spice: 2,
    targetArticles: 8,
    kind: 'anteprima',
    ...over,
  });

  it('una vigilia non stampa un necrologio per chi non ha ancora giocato', () => {
    const plan = planEdition(vigilia());
    expect(plan.articles.length).toBeGreaterThanOrEqual(5);
    for (const a of plan.articles) {
      expect(
        a.format.edizioni,
        `${a.format.id} non si dichiara adatto a un'anteprima`,
      ).toContain('anteprima');
    }
  });

  it('e un retrospettivo non usa i format nati per la vigilia', () => {
    const plan = planEdition({ ...vigilia(), kind: 'giornale' });
    for (const a of plan.articles) expect(a.format.edizioni).toContain('giornale');
  });

  it('senza accoppiamenti nessun pezzo promette una sfida da presentare', () => {
    /**
     * `presentazione_sfida` e' l'apertura nata per la vigilia, e la sua forma
     * PROMETTE due squadre che si incontrano. Alla prima giornata di una lega
     * nuova il calendario puo' non essere ancora arrivato: dato un solo fatto
     * d'asta, quel format scriverebbe di uno scontro che non ha. Misurato: il
     * giornale apriva esattamente cosi'.
     */
    const plan = planEdition(vigilia());
    const conAncoraSbagliata = plan.articles.filter(
      (a) => a.format.richiedeAncora
        && !a.format.richiedeAncora.includes(a.facts[0]?.type ?? 'GOLEADA'),
    );
    expect(
      conAncoraSbagliata.map((a) => `${a.format.id}/${a.facts[0]?.type}`),
    ).toEqual([]);
    expect(plan.articles.map((a) => a.format.id)).not.toContain('presentazione_sfida');
  });

  it('con gli accoppiamenti la sfida di giornata torna disponibile', () => {
    const sfida: NarrativeFact = {
      id: 'sfida-1',
      type: 'SFIDA_IN_PROGRAMMA',
      matchday: 1,
      subjects: [
        { kind: 'team', id: 't0', display: 'Squadra 0' },
        { kind: 'team', id: 't1', display: 'Squadra 1' },
      ],
      numbers: { spesa_casa: '1000', spesa_ospite: '913' },
      polarity: 'mediocrita',
      // Piu' drammatica di ogni fatto d'asta: e' l'ancora dell'apertura.
      drama: 90,
      rarityPercentile: null,
      plain: 'Squadra 0 contro Squadra 1.',
      evidence: [],
    };
    const plan = planEdition(vigilia({
      facts: [sfida, ...Array.from({ length: 14 }, (_, i) => fattoAsta(i))],
    }));
    expect(plan.articles[0]?.format.id).toBe('presentazione_sfida');
    expect(plan.articles[0]?.facts[0]?.type).toBe('SFIDA_IN_PROGRAMMA');
  });

  it('ogni slot dell\'impaginato ha almeno un format per ciascun tipo di edizione', () => {
    /**
     * Controllo STRUTTURALE sul mazzo, non sul comportamento: e' cio' che
     * impedisce che una carta aggiunta domani lasci uno slot scoperto in una
     * delle due edizioni. Uno slot scoperto non da' errore — da' un giornale
     * senza prima pagina.
     */
    for (const kind of ['giornale', 'anteprima'] as const) {
      for (const slot of ['apertura', 'spalla', 'taglio_basso', 'interno', 'rubrica'] as const) {
        const carte = FORMAT_DECK.filter(
          (f) => f.edizioni.includes(kind) && f.slots.includes(slot),
        );
        expect(carte.length, `${kind}/${slot} senza format`).toBeGreaterThan(0);
        // E almeno una senza vincolo di ancora: altrimenti lo slot si copre
        // solo quando capita il fatto giusto.
        expect(
          carte.some((f) => !f.richiedeAncora),
          `${kind}/${slot}: ogni format pretende un'ancora precisa`,
        ).toBe(true);
      }
    }
  });
});
