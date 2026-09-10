import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Edition, FactPack, LeagueRuleset } from '@fantacomics/core';
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
/**
 * La configurazione di una lega: nome, regolamento, livello di piccante.
 * E' cio' che l'admin imposta una volta e che governa ogni edizione
 * successiva — quindi e' stato di prodotto, non impostazioni dell'interfaccia.
 */
export type LeagueConfig = {
  leagueId: string;
  /** Chi possiede la lega. Nessuna lega esiste senza un proprietario. */
  ownerId: string;
  /**
   * Il segreto di condivisione, separato dall'id interno e revocabile.
   *
   * Il giornale DEVE essere leggibile senza login, altrimenti muore l'intero
   * ciclo di condivisione che regge il prodotto. Ma usare l'id interno come
   * indirizzo pubblico lega per sempre la lettura all'identita' della lega e
   * non si puo' revocare. Uno slug lungo e casuale si rigenera in un secondo
   * quando un link finisce dove non doveva.
   */
  publicSlug: string;
  leagueName: string;
  ruleset: LeagueRuleset;
  spice: 1 | 2 | 3;
  createdAt: string;
  /** L'ultima giornata per cui esiste un'edizione. */
  lastMatchday: number | null;
};

/**
 * Un'edizione pubblicata è edizione PIÙ fact pack.
 *
 * Salvare la sola Edition la rende illeggibile: i blocchi tabellino
 * referenziano i fatti per id e i numeri li mette il renderer leggendoli dal
 * pack. Senza pack il giornale non si può ricostruire, e un archivio che non
 * si rilegge non è un archivio.
 */
export type PublishedEdition = {
  edition: Edition;
  pack: FactPack;
};

export interface LeagueStore {
  /**
   * Ogni lettura di configurazione passa da un proprietario o da uno slug.
   * Non esiste un metodo che restituisca una lega senza uno dei due: e' cosi'
   * che il controllo di proprieta' diventa impossibile da dimenticare, invece
   * di dipendere dal fatto che ogni pagina si ricordi di farlo.
   */
  listLeagues(ownerId: string): Promise<LeagueConfig[]>;
  getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null>;
  getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null>;
  saveConfig(config: LeagueConfig): Promise<void>;
  getEdition(leagueId: string, matchday: number): Promise<PublishedEdition | null>;
  listEditions(leagueId: string): Promise<number[]>;
  getMemory(leagueId: string): Promise<EditorialMemory>;
  saveMemory(leagueId: string, memory: EditorialMemory): Promise<void>;
  getHistory(leagueId: string): Promise<LeagueHistory>;
  appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void>;
  saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void>;
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

  private async readConfig(leagueId: string): Promise<LeagueConfig | null> {
    return this.readJson<LeagueConfig | null>(this.path('config', `${leagueId}.json`), null);
  }

  async listLeagues(ownerId: string): Promise<LeagueConfig[]> {
    const index = await this.readJson<string[]>(this.path('leagues', '_index.json'), []);
    const configs = await Promise.all(index.map((id) => this.readConfig(id)));
    return configs
      .filter((c): c is LeagueConfig => c !== null && c.ownerId === ownerId)
      .sort((a, b) => a.leagueName.localeCompare(b.leagueName));
  }

  async getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null> {
    const config = await this.readConfig(leagueId);
    // Lega inesistente e lega altrui rispondono allo stesso modo: distinguerle
    // direbbe a un estraneo quali id esistono.
    return config && config.ownerId === ownerId ? config : null;
  }

  async getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null> {
    const map = await this.readJson<Record<string, string>>(this.path('slugs.json'), {});
    const leagueId = map[publicSlug];
    return leagueId ? this.readConfig(leagueId) : null;
  }

  async saveConfig(config: LeagueConfig): Promise<void> {
    const precedente = await this.readConfig(config.leagueId);
    await this.writeJson(this.path('config', `${config.leagueId}.json`), config);

    const index = await this.readJson<string[]>(this.path('leagues', '_index.json'), []);
    if (!index.includes(config.leagueId)) {
      await this.writeJson(this.path('leagues', '_index.json'), [...index, config.leagueId]);
    }

    const map = await this.readJson<Record<string, string>>(this.path('slugs.json'), {});
    // Uno slug rigenerato deve smettere di funzionare: revocare significa
    // togliere il vecchio, non solo aggiungere il nuovo.
    if (precedente && precedente.publicSlug !== config.publicSlug) {
      delete map[precedente.publicSlug];
    }
    map[config.publicSlug] = config.leagueId;
    await this.writeJson(this.path('slugs.json'), map);
  }

  async getEdition(leagueId: string, matchday: number): Promise<PublishedEdition | null> {
    return this.readJson<PublishedEdition | null>(
      this.path('editions', leagueId, `g${matchday}.json`), null,
    );
  }

  async listEditions(leagueId: string): Promise<number[]> {
    try {
      const files = await readdir(this.path('editions', leagueId));
      return files
        .map((f) => Number(/^g(\d+)\.json$/.exec(f)?.[1]))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => b - a);
    } catch {
      return [];
    }
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

  async saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void> {
    await this.writeJson(
      this.path('editions', leagueId, `g${edition.meta.matchday}.json`),
      { edition, pack } satisfies PublishedEdition,
    );
    const config = await this.readConfig(leagueId);
    if (config && (config.lastMatchday ?? 0) < edition.meta.matchday) {
      await this.saveConfig({ ...config, lastMatchday: edition.meta.matchday });
    }
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
  private readonly editions = new Map<string, PublishedEdition>();
  private readonly configs = new Map<string, LeagueConfig>();
  private corpus: number[] = [];

  async listLeagues(ownerId: string): Promise<LeagueConfig[]> {
    return [...this.configs.values()].filter((c) => c.ownerId === ownerId);
  }
  async getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null> {
    const c = this.configs.get(leagueId) ?? null;
    return c && c.ownerId === ownerId ? c : null;
  }
  async getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null> {
    return [...this.configs.values()].find((c) => c.publicSlug === publicSlug) ?? null;
  }
  async saveConfig(config: LeagueConfig): Promise<void> { this.configs.set(config.leagueId, config); }
  async getEdition(leagueId: string, matchday: number): Promise<PublishedEdition | null> {
    return this.editions.get(`${leagueId}:${matchday}`) ?? null;
  }
  async listEditions(leagueId: string): Promise<number[]> {
    return [...this.editions.keys()]
      .filter((k) => k.startsWith(`${leagueId}:`))
      .map((k) => Number(k.split(':')[1]))
      .sort((a, b) => b - a);
  }

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

  async saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void> {
    this.editions.set(`${leagueId}:${edition.meta.matchday}`, { edition, pack });
    const config = this.configs.get(leagueId);
    if (config && (config.lastMatchday ?? 0) < edition.meta.matchday) {
      this.configs.set(leagueId, { ...config, lastMatchday: edition.meta.matchday });
    }
  }

  async getCorpus(): Promise<RarityCorpus | null> {
    return this.corpus.length === 0 ? null : { sortedTeamPoints: this.corpus };
  }

  async addToCorpus(points: readonly number[]): Promise<void> {
    this.corpus = [...this.corpus, ...points].sort((a, b) => a - b);
  }
}
