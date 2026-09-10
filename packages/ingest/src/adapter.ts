import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';
import type { Observation } from './readiness.js';

/**
 * L'ANTI-CORRUPTION LAYER.
 *
 * Ogni collector produce lo schema canonico. Nulla a valle sa da dove
 * arrivano i dati: cambiare piattaforma, o perderla, non tocca una riga del
 * motore di calcolo.
 *
 * La separazione dei due metodi non è cosmetica: il 95% del volume è globale
 * (voti, gol, minuti di Serie A) ed è IDENTICO per tutte le leghe. Si scarica
 * UNA volta per giornata, non una volta per lega. È la scelta che riduce le
 * richieste di ordini di grandezza, e con esse il rischio di ban.
 */
export interface PlatformAdapter {
  readonly platform: string;

  /** Piano GLOBALE: una chiamata per giornata, condivisa da tutte le leghe. */
  fetchSerieAMatchday(season: string, matchday: number): Promise<SerieAMatchday>;

  /** Piano TENANT: una chiamata a settimana per lega. */
  fetchLeagueWeek(ref: LeagueRef, matchday: number): Promise<LeagueWeekSnapshot>;

  /** Osservazione leggera per la macchina a stati, senza scaricare tutto. */
  observe(season: string, matchday: number): Promise<Observation>;
}

export type LeagueRef = {
  leagueId: string;
  /** Identificatore sulla piattaforma di origine (slug, id numerico, url). */
  externalId: string;
  /**
   * Credenziali per le leghe private. Preferire SEMPRE il collector via
   * estensione: non custodire password di terzi è una riduzione di rischio
   * che nessuna cifratura può eguagliare.
   */
  credentialsRef?: string;
};

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'parse' | 'not-found' | 'rate-limit',
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Registro degli adapter.
 * Esiste dal giorno 1 con una sola implementazione, e questo è il punto:
 * un adapter in più è una settimana di lavoro, una riscrittura sotto
 * ricatto di una piattaforma che chiude è un trimestre.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): this {
    this.adapters.set(adapter.platform, adapter);
    return this;
  }

  get(platform: string): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new AdapterError(`Nessun adapter registrato per "${platform}".`, 'not-found', false);
    }
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
