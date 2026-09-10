import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Edition } from '@fantacomics/core';
import type { HistoricalMatchday, LeagueHistory, RarityCorpus } from '@fantacomics/facts';
import { emptyMemory, type EditorialMemory } from '@fantacomics/editorial';

/**
 * Lo stato persistente di una lega.
 *
 * L'interfaccia è deliberatamente minuscola: in produzione la implementa
 * Postgres (relazionale per rose e giornate, JSONB per i payload variabili,
 * pgvector per la memoria semantica anti-ripetizione, RLS per il
 * multi-tenant). Qui c'è la versione su file, che serve a due cose reali:
 * far girare la pipeline senza infrastruttura e tenere il resto del codice
 * ignaro di dove finiscano i dati.
 */
export interface LeagueStore {
  getMemory(leagueId: string): Promise<EditorialMemory>;
  saveMemory(leagueId: string, memory: EditorialMemory): Promise<void>;
  getHistory(leagueId: string): Promise<LeagueHistory>;
  appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void>;
  saveEdition(leagueId: string, edition: Edition): Promise<void>;
  /** Distribuzione cross-lega: il vantaggio competitivo che cresce con gli utenti. */
  getCorpus(): Promise<RarityCorpus | null>;
  addToCorpus(points: readonly number[]): Promise<void>;
}

type LeagueState = {
  memory: EditorialMemory;
  history: HistoricalMatchday[];
};

export class FileLeagueStore implements LeagueStore {
  constructor(private readonly root: string) {}

  private path(...parts: string[]): string {
    return join(resolve(this.root), ...parts);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private async state(leagueId: string): Promise<LeagueState> {
    return this.readJson<LeagueState>(this.path('leagues', `${leagueId}.json`), {
      memory: emptyMemory(), history: [],
    });
  }

  async getMemory(leagueId: string): Promise<EditorialMemory> {
    return (await this.state(leagueId)).memory;
  }

  async saveMemory(leagueId: string, memory: EditorialMemory): Promise<void> {
    const state = await this.state(leagueId);
    await this.writeJson(this.path('leagues', `${leagueId}.json`), { ...state, memory });
  }

  async getHistory(leagueId: string): Promise<LeagueHistory> {
    return { entries: (await this.state(leagueId)).history };
  }

  async appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void> {
    const state = await this.state(leagueId);
    // Idempotente: rieseguire la stessa giornata sostituisce, non duplica.
    const history = state.history.filter((h) => h.matchday !== entry.matchday);
    history.push(entry);
    history.sort((a, b) => a.matchday - b.matchday);
    await this.writeJson(this.path('leagues', `${leagueId}.json`), { ...state, history });
  }

  async saveEdition(leagueId: string, edition: Edition): Promise<void> {
    await this.writeJson(
      this.path('editions', leagueId, `g${edition.meta.matchday}.json`),
      edition,
    );
  }

  async getCorpus(): Promise<RarityCorpus | null> {
    const points = await this.readJson<number[]>(this.path('corpus.json'), []);
    return points.length === 0 ? null : { sortedTeamPoints: points };
  }

  async addToCorpus(points: readonly number[]): Promise<void> {
    const existing = await this.readJson<number[]>(this.path('corpus.json'), []);
    const merged = [...existing, ...points].sort((a, b) => a - b);
    await this.writeJson(this.path('corpus.json'), merged);
  }
}

/** Store in memoria: test e anteprime, nessun file sul disco. */
export class InMemoryLeagueStore implements LeagueStore {
  private readonly states = new Map<string, LeagueState>();
  private readonly editions = new Map<string, Edition>();
  private corpus: number[] = [];

  private state(leagueId: string): LeagueState {
    let s = this.states.get(leagueId);
    if (!s) { s = { memory: emptyMemory(), history: [] }; this.states.set(leagueId, s); }
    return s;
  }

  async getMemory(leagueId: string): Promise<EditorialMemory> { return this.state(leagueId).memory; }
  async saveMemory(leagueId: string, memory: EditorialMemory): Promise<void> { this.state(leagueId).memory = memory; }
  async getHistory(leagueId: string): Promise<LeagueHistory> { return { entries: this.state(leagueId).history }; }

  async appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void> {
    const s = this.state(leagueId);
    s.history = [...s.history.filter((h) => h.matchday !== entry.matchday), entry]
      .sort((a, b) => a.matchday - b.matchday);
  }

  async saveEdition(leagueId: string, edition: Edition): Promise<void> {
    this.editions.set(`${leagueId}:${edition.meta.matchday}`, edition);
  }

  getEdition(leagueId: string, matchday: number): Edition | undefined {
    return this.editions.get(`${leagueId}:${matchday}`);
  }

  async getCorpus(): Promise<RarityCorpus | null> {
    return this.corpus.length === 0 ? null : { sortedTeamPoints: this.corpus };
  }

  async addToCorpus(points: readonly number[]): Promise<void> {
    this.corpus = [...this.corpus, ...points].sort((a, b) => a - b);
  }
}
