import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  Edition, EditionKind, FactPack, LeagueRoster, LeagueRuleset,
} from '@fantacomics/core';
import { LeagueRosterSchema } from '@fantacomics/core';
import type { HistoricalMatchday, LeagueHistory, RarityCorpus } from '@fantacomics/facts';
import { emptyMemory, type EditorialMemory } from '@fantacomics/editorial';
import type { Observation } from '@fantacomics/ingest';

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
  /**
   * La chiave con cui l'estensione del browser parla di QUESTA lega.
   *
   * Separata dallo slug pubblico perche' concede un potere diverso: lo slug
   * fa leggere il giornale, questa fa entrare dati. Un capability distinto per
   * ogni potere significa che revocare la condivisione non spegne
   * l'estensione, e togliere l'estensione non rompe i link gia' inviati.
   *
   * `null` finche' l'admin non la chiede: una credenziale che esiste da prima
   * che serva e' una credenziale in giro senza motivo.
   */
  relaySecret: string | null;
  leagueName: string;
  ruleset: LeagueRuleset;
  spice: 1 | 2 | 3;
  createdAt: string;
  /** L'ultima giornata per cui esiste un'edizione. */
  lastMatchday: number | null;
  /**
   * Da dove arrivano i dati della giornata, quando arrivano da soli.
   *
   * `profilo` sceglie quale servizio interrogare — e' un nome, non un URL,
   * perche' il servizio e' un dato versionato lato server. `leagueExternalId`
   * e' come quel servizio chiama QUESTA lega.
   *
   * Assente significa che la lega non passa da un servizio: usa l'estensione
   * o i file. Non e' uno stato degradato, e' l'altra meta' del prodotto.
   */
  fonte?: { profilo: string; leagueExternalId: string } | null;
};

/**
 * Un'edizione pubblicata è edizione PIÙ fact pack.
 *
 * Salvare la sola Edition la rende illeggibile: i blocchi tabellino
 * referenziano i fatti per id e i numeri li mette il renderer leggendoli dal
 * pack. Senza pack il giornale non si può ricostruire, e un archivio che non
 * si rilegge non è un archivio.
 */
/** L'indirizzo di un'edizione dentro una lega. */
export type EditionRef = {
  matchday: number;
  kind: EditionKind;
};

/**
 * Il nome del file (e la chiave in memoria) di un'edizione.
 *
 * Il retrospettivo conserva il nome che aveva PRIMA che l'anteprima esistesse:
 * gli archivi gia' scritti su disco continuano a rileggersi, e non serve una
 * migrazione dei file per una tabella che non ha ancora un utente pagante.
 */
export function chiaveEdizione(matchday: number, kind: EditionKind | undefined): string {
  return tipoEdizione(kind) === 'anteprima' ? `g${matchday}-anteprima` : `g${matchday}`;
}

/**
 * IL TIPO DI UN PACK, NORMALIZZATO. Tutto cio' che non e' esplicitamente
 * un'anteprima e' un retrospettivo.
 *
 * Non e' pignoleria difensiva: `pack.kind` ha un valore predefinito nello
 * schema, ma i pack che arrivano da un archivio scritto prima che il campo
 * esistesse NON passano da quello schema — Postgres restituisce `row.pack` con
 * un cast, non con un parse, e su disco il JSON e' quello che era. Senza
 * normalizzazione un pack vecchio produce la chiave «g7-undefined» e la sua
 * edizione diventa illeggibile: trovato dalla suite di contratto, che usa
 * proprio un pack senza `kind`.
 */
export function tipoEdizione(kind: EditionKind | undefined): EditionKind {
  return kind === 'anteprima' ? 'anteprima' : 'giornale';
}

const NOME_EDIZIONE = /^g(\d+)(?:-(anteprima))?\.json$/;

/**
 * SOLO IL RETROSPETTIVO FA AVANZARE `lastMatchday`.
 *
 * Quel campo dice al pianificatore quale giornata consegnare la prossima
 * volta. Se la vigilia della 12 lo portasse a 12, il pianificatore passerebbe
 * alla 13 e il retrospettivo della 12 — il numero che racconta le partite —
 * non uscirebbe mai. Sarebbe il difetto peggiore possibile: silenzioso,
 * identico a un funzionamento normale, e scoperto dal cliente.
 */
function avanzaPuntatore(pack: FactPack): boolean {
  return tipoEdizione(pack.kind) !== 'anteprima';
}

export type PublishedEdition = {
  edition: Edition;
  pack: FactPack;
  /**
   * Quando un umano ha detto "va bene lo stesso".
   *
   * `null` finche' nessuno l'ha guardata. Serve solo alle edizioni sotto
   * soglia: quelle sopra non hanno bisogno di permesso.
   */
  approvedAt: string | null;
};

/**
 * Sotto questa soglia l'edizione NON si serve al pubblico: va in revisione.
 *
 * Sta qui e non nella pipeline perche' non e' una proprieta' della
 * generazione, e' una proprieta' della lettura. Chi serve il giornale deve
 * poterla applicare senza tirarsi dentro tutta la pipeline — ed e' proprio
 * perche' viveva solo dentro la pipeline che nessuno la applicava.
 */
export const MIN_PUBLISH_CONFIDENCE = 0.6;

/**
 * Si puo' servire al pubblico?
 *
 * Il numero da solo non basta: un'edizione sotto soglia che un umano ha
 * guardato e approvato e' pubblicabile, ed e' tutto il senso di avere una
 * coda di revisione invece di un cestino.
 */
export function edizioneLeggibile(published: PublishedEdition): boolean {
  return published.approvedAt !== null
    || published.edition.meta.confidence >= MIN_PUBLISH_CONFIDENCE;
}

export interface LeagueStore {
  /**
   * Ogni lettura di configurazione passa da un proprietario o da uno slug.
   * Non esiste un metodo che restituisca una lega senza uno dei due: e' cosi'
   * che il controllo di proprieta' diventa impossibile da dimenticare, invece
   * di dipendere dal fatto che ogni pagina si ricordi di farlo.
   */
  listLeagues(ownerId: string): Promise<LeagueConfig[]>;
  getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null>;
  /**
   * Le leghe che hanno una fonte automatica configurata.
   *
   * E' l'UNICO metodo che restituisce leghe senza passare da un proprietario,
   * e la deroga va motivata perche' altrove quella regola e' la ragione per
   * cui il controllo di proprieta' non si puo' dimenticare.
   *
   * La differenza e' chi chiede: gli altri metodi servono una RICHIESTA, e li'
   * l'identita' di chi chiede e' tutto. Questo serve il pianificatore, che non
   * e' un utente — e' il sistema che cerca il proprio lavoro da fare. Un cron
   * che dovesse indovinare i proprietari per scoprire cosa consegnare non
   * sarebbe piu' sicuro, sarebbe solo impossibile.
   *
   * Il nome e' deliberatamente quello di un compito, non di una lettura: non
   * deve mai finire dietro una pagina. Restituisce solo leghe con `fonte`
   * impostata, quindi non e' nemmeno un elenco completo.
   */
  legheDaConsegnare(): Promise<LeagueConfig[]>;
  getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null>;
  /**
   * Risolve la chiave dell'estensione. E' l'unico modo per cui il relay sa a
   * quale lega appartiene cio' che riceve: senza, l'endpoint dovrebbe fidarsi
   * di un identificatore scritto nel corpo della richiesta, che e' come dire
   * che non c'e' autenticazione.
   */
  getConfigByRelaySecret(relaySecret: string): Promise<LeagueConfig | null>;
  saveConfig(config: LeagueConfig): Promise<void>;
  /**
   * Un'edizione, identificata da giornata E TIPO.
   *
   * IL TIPO FA PARTE DELLA CHIAVE, e non e' un dettaglio di modellazione: le
   * due uscite della settimana parlano della STESSA giornata — la vigilia la
   * mattina in cui si comincia, il retrospettivo la mattina dopo l'ultima
   * partita. Con la sola giornata come chiave la seconda sovrascriverebbe la
   * prima, e il cliente perderebbe un numero su due senza alcun errore.
   *
   * Predefinito `giornale`: ogni chiamante scritto prima che l'anteprima
   * esistesse chiedeva il retrospettivo, e continua a ottenere quello.
   */
  getEdition(
    leagueId: string, matchday: number, kind?: EditionKind,
  ): Promise<PublishedEdition | null>;
  listEditions(leagueId: string): Promise<EditionRef[]>;
  getMemory(leagueId: string): Promise<EditorialMemory>;
  saveMemory(leagueId: string, memory: EditorialMemory): Promise<void>;
  getHistory(leagueId: string): Promise<LeagueHistory>;
  appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void>;
  saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void>;
  /**
   * Approva un'edizione sotto soglia. Dice se l'ha approvata questa chiamata:
   * un'approvazione che non trova l'edizione non deve poter dire di si'.
   */
  approveEdition(
    leagueId: string, matchday: number, at: string, kind?: EditionKind,
  ): Promise<boolean>;
  /**
   * Le rose della lega: durano una stagione, non una giornata.
   *
   * Stanno qui e non nello snapshot settimanale perche' hanno un ciclo di vita
   * diverso: l'admin le carica una volta e poi ogni giornata le usa. Tenerle
   * dentro lo snapshot obbligherebbe a ricaricarle ogni settimana, che e'
   * esattamente l'attrito che fa smettere.
   */
  getRoster(leagueId: string): Promise<LeagueRoster | null>;
  saveRoster(leagueId: string, roster: LeagueRoster): Promise<void>;
  /**
   * Le osservazioni della giornata GLOBALE di Serie A.
   *
   * Stanno nello store e non in memoria perche' la macchina a stati decide
   * sulla base di LETTURE CONSECUTIVE: due letture identiche significano voti
   * stabili. Un processo di cron che parte, legge una volta e termina non
   * accumulerebbe mai niente, e la giornata non sarebbe mai dichiarata pronta
   * — cioe' la consegna automatica non partirebbe mai.
   *
   * Non sono per lega: sono di tutti, come il piano globale a cui
   * appartengono.
   */
  getOsservazioni(season: string, matchday: number): Promise<Observation[]>;
  appendOsservazione(season: string, matchday: number, obs: Observation): Promise<void>;
  /** Distribuzione cross-lega: il vantaggio competitivo che cresce con gli utenti. */
  getCorpus(): Promise<RarityCorpus | null>;
  addToCorpus(points: readonly number[]): Promise<void>;
}

type LeagueState = {
  memory: EditorialMemory;
  history: HistoricalMatchday[];
};

/**
 * Un solo segmento: niente separatori, niente risalite, niente nomi vuoti.
 * L'underscore iniziale serve (`_index.json`); il punto iniziale no, ed e'
 * proprio quello che apre `..`.
 */
const SEGMENTO_VALIDO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;

export class FileLeagueStore implements LeagueStore {
  constructor(private readonly root: string) {}

  /**
   * Un id di lega arriva dall'URL: non e' un nome di file finche' non lo si e'
   * verificato. Oggi non esiste una via d'uscita, perche' ogni lettura passa
   * comunque dal confronto sul proprietario; ma il giorno in cui un chiamante
   * saltasse quel confronto, `../../` in un id trasformerebbe lo store in
   * lettura e scrittura arbitraria di file.
   *
   * Il controllo sta QUI perche' questo e' il punto in cui un id diventa un
   * percorso: metterlo nei chiamanti significa affidarsi al fatto che tutti se
   * lo ricordino, ed e' esattamente il tipo di garanzia che invecchia male.
   * Un segmento fuori forma non e' un caso previsto, quindi tira.
   */
  private path(...parts: string[]): string {
    for (const part of parts) {
      if (!SEGMENTO_VALIDO.test(part)) {
        throw new Error(`segmento di percorso non valido: ${JSON.stringify(part)}`);
      }
    }
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
    // Unico ingresso in cui l'id arriva davvero da fuori (l'URL di /lega/[id]).
    // Un id malformato e' una lega che non esiste, non un errore da mostrare:
    // rispondere "non trovata" e' anche cio' che tiene indistinguibili lega
    // inesistente e lega altrui.
    if (!SEGMENTO_VALIDO.test(`${leagueId}.json`)) return null;
    return this.readJson<LeagueConfig | null>(this.path('config', `${leagueId}.json`), null);
  }

  /**
   * Tutte le configurazioni presenti, dall'indice.
   *
   * Sta in un metodo privato perche' due chiamanti leggevano lo stesso indice
   * scrivendone il percorso ciascuno per conto suo — e uno dei due lo aveva
   * scritto sbagliato. Un percorso ripetuto e' un percorso che prima o poi
   * diverge; ripetuto una volta sola non puo'.
   */
  private async tutteLeConfigurazioni(): Promise<LeagueConfig[]> {
    const index = await this.readJson<string[]>(this.path('leagues', '_index.json'), []);
    const configs = await Promise.all(index.map((id) => this.readConfig(id)));
    return configs.filter((c): c is LeagueConfig => c !== null);
  }

  async listLeagues(ownerId: string): Promise<LeagueConfig[]> {
    return (await this.tutteLeConfigurazioni())
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => a.leagueName.localeCompare(b.leagueName));
  }

  async legheDaConsegnare(): Promise<LeagueConfig[]> {
    return (await this.tutteLeConfigurazioni()).filter((c) => !!c.fonte);
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

  async getConfigByRelaySecret(relaySecret: string): Promise<LeagueConfig | null> {
    if (relaySecret === '') return null;
    const map = await this.readJson<Record<string, string>>(this.path('relay.json'), {});
    const leagueId = map[relaySecret];
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

    // Stessa regola per la chiave dell'estensione: ruotarla o revocarla deve
    // togliere la vecchia, non solo aggiungere la nuova.
    const relay = await this.readJson<Record<string, string>>(this.path('relay.json'), {});
    if (precedente?.relaySecret && precedente.relaySecret !== config.relaySecret) {
      delete relay[precedente.relaySecret];
    }
    if (config.relaySecret) relay[config.relaySecret] = config.leagueId;
    await this.writeJson(this.path('relay.json'), relay);
  }

  async getEdition(
    leagueId: string, matchday: number, kind: EditionKind = 'giornale',
  ): Promise<PublishedEdition | null> {
    const letta = await this.readJson<PublishedEdition | null>(
      this.path('editions', leagueId, `${chiaveEdizione(matchday, kind)}.json`), null,
    );
    // Le edizioni scritte prima che l'approvazione esistesse non hanno il
    // campo: valgono come non approvate, che e' la lettura prudente.
    return letta ? { ...letta, approvedAt: letta.approvedAt ?? null } : null;
  }

  async approveEdition(
    leagueId: string, matchday: number, at: string, kind: EditionKind = 'giornale',
  ): Promise<boolean> {
    const corrente = await this.getEdition(leagueId, matchday, kind);
    if (!corrente) return false;
    await this.writeJson(
      this.path('editions', leagueId, `${chiaveEdizione(matchday, kind)}.json`),
      { ...corrente, approvedAt: at } satisfies PublishedEdition,
    );
    return true;
  }

  async listEditions(leagueId: string): Promise<EditionRef[]> {
    try {
      const files = await readdir(this.path('editions', leagueId));
      return files
        .map((f): EditionRef | null => {
          const m = NOME_EDIZIONE.exec(f);
          const n = Number(m?.[1]);
          if (!Number.isInteger(n)) return null;
          return { matchday: n, kind: m?.[2] === 'anteprima' ? 'anteprima' : 'giornale' };
        })
        .filter((r): r is EditionRef => r !== null)
        // Giornata decrescente, e a pari giornata prima il retrospettivo:
        // e' il piu' recente dei due, quindi quello che l'archivio deve
        // mostrare in testa.
        .sort((a, b) => b.matchday - a.matchday || a.kind.localeCompare(b.kind));
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
    // Rigenerare una giornata azzera l'approvazione: il testo e' cambiato,
    // quindi il "va bene" di prima non riguarda piu' questo giornale.
    await this.writeJson(
      this.path('editions', leagueId, `${chiaveEdizione(edition.meta.matchday, pack.kind)}.json`),
      { edition, pack, approvedAt: null } satisfies PublishedEdition,
    );
    if (avanzaPuntatore(pack)) {
      const config = await this.readConfig(leagueId);
      if (config && (config.lastMatchday ?? 0) < edition.meta.matchday) {
        await this.saveConfig({ ...config, lastMatchday: edition.meta.matchday });
      }
    }
  }

  async getRoster(leagueId: string): Promise<LeagueRoster | null> {
    if (!SEGMENTO_VALIDO.test(leagueId)) return null;
    const grezzo = await this.readJson<unknown>(this.path('rose', `${leagueId}.json`), null);
    if (grezzo === null) return null;
    // Un file su disco puo' essere stato scritto da una versione precedente o
    // corrotto a meta' scrittura: si valida in lettura, e una rosa illeggibile
    // e' una rosa assente invece di un guasto piu' a valle.
    const esito = LeagueRosterSchema.safeParse(grezzo);
    return esito.success ? esito.data : null;
  }

  async saveRoster(leagueId: string, roster: LeagueRoster): Promise<void> {
    await this.writeJson(this.path('rose', `${leagueId}.json`), LeagueRosterSchema.parse(roster));
  }

  /**
   * Si conservano le ultime osservazioni, non tutte: alla macchina a stati
   * servono le ultime due o tre, e un file che cresce a ogni passata del cron
   * e' un file che prima o poi qualcuno deve potare a mano.
   */
  private static readonly MAX_OSSERVAZIONI = 12;

  async getOsservazioni(season: string, matchday: number): Promise<Observation[]> {
    if (!SEGMENTO_VALIDO.test(season)) return [];
    return this.readJson<Observation[]>(
      this.path('osservazioni', `${season}-${matchday}.json`), [],
    );
  }

  async appendOsservazione(season: string, matchday: number, obs: Observation): Promise<void> {
    const storiche = await this.getOsservazioni(season, matchday);
    const prossime = [...storiche, obs].slice(-FileLeagueStore.MAX_OSSERVAZIONI);
    await this.writeJson(this.path('osservazioni', `${season}-${matchday}.json`), prossime);
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
  private readonly rose = new Map<string, LeagueRoster>();
  private readonly osservazioni = new Map<string, Observation[]>();
  private corpus: number[] = [];

  async listLeagues(ownerId: string): Promise<LeagueConfig[]> {
    return [...this.configs.values()].filter((c) => c.ownerId === ownerId);
  }
  async legheDaConsegnare(): Promise<LeagueConfig[]> {
    return [...this.configs.values()].filter((c) => !!c.fonte);
  }
  async getConfigForOwner(leagueId: string, ownerId: string): Promise<LeagueConfig | null> {
    const c = this.configs.get(leagueId) ?? null;
    return c && c.ownerId === ownerId ? c : null;
  }
  async getConfigBySlug(publicSlug: string): Promise<LeagueConfig | null> {
    return [...this.configs.values()].find((c) => c.publicSlug === publicSlug) ?? null;
  }
  async getConfigByRelaySecret(relaySecret: string): Promise<LeagueConfig | null> {
    if (relaySecret === '') return null;
    return [...this.configs.values()].find((c) => c.relaySecret === relaySecret) ?? null;
  }
  async saveConfig(config: LeagueConfig): Promise<void> { this.configs.set(config.leagueId, config); }
  async getEdition(
    leagueId: string, matchday: number, kind: EditionKind = 'giornale',
  ): Promise<PublishedEdition | null> {
    return this.editions.get(`${leagueId}:${chiaveEdizione(matchday, kind)}`) ?? null;
  }
  async listEditions(leagueId: string): Promise<EditionRef[]> {
    return [...this.editions.values()]
      .filter((e) => e.edition.meta.leagueId === leagueId)
      .map((e) => ({ matchday: e.edition.meta.matchday, kind: tipoEdizione(e.pack.kind) }))
      .sort((a, b) => b.matchday - a.matchday || a.kind.localeCompare(b.kind));
  }

  private state(leagueId: string): LeagueState {
    let s = this.states.get(leagueId);
    if (!s) { s = { memory: emptyMemory(), history: [] }; this.states.set(leagueId, s); }
    return s;
  }

  async getRoster(leagueId: string): Promise<LeagueRoster | null> {
    return this.rose.get(leagueId) ?? null;
  }
  async saveRoster(leagueId: string, roster: LeagueRoster): Promise<void> {
    this.rose.set(leagueId, LeagueRosterSchema.parse(roster));
  }

  async getOsservazioni(season: string, matchday: number): Promise<Observation[]> {
    return [...(this.osservazioni.get(`${season}:${matchday}`) ?? [])];
  }
  async appendOsservazione(season: string, matchday: number, obs: Observation): Promise<void> {
    const k = `${season}:${matchday}`;
    this.osservazioni.set(k, [...(this.osservazioni.get(k) ?? []), obs].slice(-12));
  }

  async getMemory(leagueId: string): Promise<EditorialMemory> { return this.state(leagueId).memory; }
  async saveMemory(leagueId: string, memory: EditorialMemory): Promise<void> { this.state(leagueId).memory = memory; }
  async getHistory(leagueId: string): Promise<LeagueHistory> { return { entries: this.state(leagueId).history }; }

  async appendHistory(leagueId: string, entry: HistoricalMatchday): Promise<void> {
    const s = this.state(leagueId);
    s.history = [...s.history.filter((h) => h.matchday !== entry.matchday), entry]
      .sort((a, b) => a.matchday - b.matchday);
  }

  async approveEdition(
    leagueId: string, matchday: number, at: string, kind: EditionKind = 'giornale',
  ): Promise<boolean> {
    const chiave = `${leagueId}:${chiaveEdizione(matchday, kind)}`;
    const corrente = this.editions.get(chiave);
    if (!corrente) return false;
    this.editions.set(chiave, { ...corrente, approvedAt: at });
    return true;
  }

  async saveEdition(leagueId: string, edition: Edition, pack: FactPack): Promise<void> {
    this.editions.set(
      `${leagueId}:${chiaveEdizione(edition.meta.matchday, pack.kind)}`,
      { edition, pack, approvedAt: null },
    );
    if (!avanzaPuntatore(pack)) return;
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
