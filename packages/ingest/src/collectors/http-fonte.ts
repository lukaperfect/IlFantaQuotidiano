import { z } from 'zod';
import { AdapterError } from '../adapter.js';
import { FieldMappingSchema } from './extension-relay.js';
import { importFromRelay } from './relay-import.js';

/**
 * LA FONTE HTTP: i dati della giornata arrivano da soli.
 *
 * Il percorso da file esiste e resta — e' l'interruttore di emergenza. Ma un
 * prodotto settimanale che chiede cinque caricamenti a mano ogni lunedi' non
 * sopravvive a tre giornate: l'abitudine si costruisce solo se il giornale
 * compare senza che nessuno faccia niente. Questo modulo e' il pezzo che
 * trasforma "si puo' caricare" in "arriva".
 *
 * DOVE STA IL LAVORO, E DOVE NON STA.
 *
 * Non sta nel fare una richiesta HTTP. Sta nel non lasciare che la forma di un
 * servizio terzo entri nel resto del sistema. Per questo la fonte NON produce
 * uno snapshot: produce i payload grezzi, che poi passano dalla STESSA
 * mappatura e dagli STESSI costruttori dell'estensione e dei CSV. Le tre
 * sorgenti convergono, e non e' un modo di dire: e' la stessa funzione.
 *
 * Da qui discende la proprieta' che conta: cambiare fornitore e' un profilo
 * nuovo — dati, non codice — e nulla a valle se ne accorge.
 *
 * I DUE PIANI, CHE QUI SI VEDONO BENISSIMO.
 *
 * Gli endpoint dichiarano su quale piano vivono. Il piano `globale` (la Serie
 * A: voti, gol, minuti) e' identico per tutte le leghe e si scarica UNA volta
 * per giornata, non una per lega. Con dieci leghe e cinque endpoint la
 * differenza e' fra cinque richieste e cinquanta, ogni volta che il cron
 * scatta. Su un'API a consumo e' la differenza fra un costo e un problema.
 */

export const MetodoSchema = z.enum(['GET', 'POST']);

export const EndpointSchema = z.object({
  /**
   * URL relativo alla base, con segnaposto `{matchday}`, `{season}`,
   * `{leagueExternalId}`. I valori vengono SEMPRE codificati: un id di lega e'
   * un dato, e un dato non deve poter aggiungere un parametro all'URL.
   */
  percorso: z.string().min(1),
  metodo: MetodoSchema.default('GET'),
  /**
   * `globale`: uguale per tutte le leghe, si legge una volta per giornata.
   * `lega`: specifico della singola lega.
   */
  piano: z.enum(['globale', 'lega']).default('globale'),
  /** Corpo per POST, con gli stessi segnaposto. */
  corpo: z.string().optional(),
  /** Se manca, la giornata si costruisce lo stesso (rose e classifica). */
  facoltativo: z.boolean().default(false),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

export const AutenticazioneSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('nessuna') }),
  /** `Authorization: Bearer <chiave>` */
  z.object({ tipo: z.literal('bearer') }),
  /** Un header dedicato, es. `X-RapidAPI-Key`. */
  z.object({ tipo: z.literal('header'), nome: z.string().min(1) }),
  /**
   * La chiave in query string. Supportata perche' diversi servizi non offrono
   * altro, ma e' la forma peggiore: finisce nei log dei proxy e nei Referer.
   * Quando esiste un header, si usa l'header.
   */
  z.object({ tipo: z.literal('query'), nome: z.string().min(1) }),
]);
export type Autenticazione = z.infer<typeof AutenticazioneSchema>;

export const ProfiloFonteSchema = z.object({
  fonte: z.string().min(1),
  version: z.number().int().min(1),
  baseUrl: z.string().url(),
  auth: AutenticazioneSchema.default({ tipo: 'nessuna' }),
  /** Header fissi richiesti dal servizio (mai credenziali: quelle stanno in `auth`). */
  headers: z.record(z.string(), z.string()).default({}),
  /** id canonico del payload -> endpoint da cui prenderlo. */
  endpoints: z.record(z.string(), EndpointSchema),
  /** id canonico del payload -> mappatura dei campi. La stessa dell'estensione. */
  mappings: z.record(z.string(), FieldMappingSchema),
});
export type ProfiloFonte = z.infer<typeof ProfiloFonteSchema>;

/* ------------------------------------------------------------------ */

/** Oltre questo una risposta non e' una giornata: e' un problema. */
const MAX_BYTE_RISPOSTA = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const TENTATIVI = 3;

export type Contesto = {
  matchday: number;
  season: string;
  /** L'identificatore della lega presso il servizio. Vuoto per il piano globale. */
  leagueExternalId?: string;
};

/**
 * Sostituisce i segnaposto codificandoli.
 *
 * Un `leagueExternalId` arriva dalla configurazione di un utente. Interpolarlo
 * grezzo in un URL gli lascerebbe aggiungere `?apiKey=...` o un altro
 * segmento di percorso: sarebbe una iniezione nell'URL, e su una chiamata
 * autenticata significa usare la nostra chiave per una richiesta che non
 * abbiamo scritto noi.
 */
export function riempi(template: string, ctx: Contesto): string {
  return template.replace(/\{(\w+)\}/g, (intero, nome: string) => {
    const valori: Record<string, string | undefined> = {
      matchday: String(ctx.matchday),
      season: ctx.season,
      leagueExternalId: ctx.leagueExternalId,
    };
    const v = valori[nome];
    if (v === undefined) {
      throw new AdapterError(
        `Il profilo usa il segnaposto "{${nome}}", che non so riempire.`, 'parse', false,
      );
    }
    return encodeURIComponent(v);
  });
}

/**
 * Traduce un esito HTTP in un errore del dominio.
 *
 * La distinzione fra "riprovabile" e "no" non e' cosmetica: e' cio' che decide
 * se il cron ritenta fra dieci minuti o se smette e avvisa. Ritentare in
 * eterno su una chiave scaduta significa non accorgersi mai che e' scaduta.
 */
function erroreDaStato(stato: number, fonte: string, corpo: string): AdapterError {
  const estratto = corpo.slice(0, 200).replace(/\s+/g, ' ').trim();
  if (stato === 401 || stato === 403) {
    return new AdapterError(
      `La fonte "${fonte}" ha rifiutato le credenziali (${stato}). La chiave e' assente, ` +
      'scaduta o non abilitata a questo endpoint.', 'auth', false,
    );
  }
  if (stato === 404) {
    return new AdapterError(
      `La fonte "${fonte}" non ha quel dato (404). ${estratto}`, 'not-found', false,
    );
  }
  if (stato === 429) {
    return new AdapterError(
      `La fonte "${fonte}" ha imposto un limite di frequenza (429).`, 'rate-limit', true,
    );
  }
  if (stato >= 500) {
    return new AdapterError(
      `La fonte "${fonte}" ha risposto ${stato}. ${estratto}`, 'network', true,
    );
  }
  return new AdapterError(
    `La fonte "${fonte}" ha risposto ${stato}. ${estratto}`, 'parse', false,
  );
}

export type OpzioniFonte = {
  profilo: ProfiloFonte;
  /**
   * La credenziale. Sta FUORI dal profilo di proposito: il profilo e' un dato
   * che si versiona, si logga e si mostra in diagnostica, e una credenziale
   * dentro un oggetto del genere prima o poi finisce in un posto sbagliato.
   */
  chiave?: string;
  /** Iniettabile per i test. Di default quella della piattaforma. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  tentativi?: number;
  /** Attesa fra i tentativi. Iniettabile perche' un test non deve dormire davvero. */
  attesa?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type Diagnostica = {
  /** Quante richieste HTTP sono partite davvero. */
  richieste: number;
  /** Quante volte una risposta e' arrivata dalla cache di giornata. */
  riusi: number;
  /** Quante risposte 304: il contenuto non e' cambiato. */
  nonModificate: number;
};

/**
 * La fonte viva.
 *
 * Non produce snapshot: produce payload. Chi li trasforma e' `importFromRelay`,
 * cioe' lo stesso codice che serve l'estensione.
 */
export class FonteHttp {
  private readonly profilo: ProfiloFonte;
  private readonly chiave: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly tentativi: number;
  private readonly attesa: (ms: number) => Promise<void>;

  /**
   * La cache del piano globale, per giornata.
   *
   * E' l'inversione architetturale del progetto resa esecutiva: dieci leghe
   * che chiedono la stessa giornata di Serie A fanno UNA richiesta. Senza
   * questa riga il costo cresce col numero di leghe invece che col numero di
   * giornate.
   */
  private readonly cacheGlobale = new Map<string, unknown>();
  /** ETag per endpoint: una 304 e' un modo economico di dire "non e' cambiato". */
  private readonly etag = new Map<string, string>();
  private readonly diagnostica: Diagnostica = { richieste: 0, riusi: 0, nonModificate: 0 };
  private readonly ultimoCorpo = new Map<string, unknown>();

  constructor(opzioni: OpzioniFonte) {
    this.profilo = ProfiloFonteSchema.parse(opzioni.profilo);
    this.chiave = opzioni.chiave;
    this.fetchImpl = opzioni.fetch ?? globalThis.fetch;
    this.timeoutMs = opzioni.timeoutMs ?? TIMEOUT_MS;
    this.tentativi = Math.max(1, opzioni.tentativi ?? TENTATIVI);
    this.attesa = opzioni.attesa ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    if (this.profilo.auth.tipo !== 'nessuna' && !this.chiave) {
      throw new AdapterError(
        `Il profilo "${this.profilo.fonte}" richiede una credenziale ma non ne ha ricevuta una.`,
        'auth', false,
      );
    }
  }

  get stato(): Readonly<Diagnostica> { return { ...this.diagnostica }; }

  /** Azzera la cache di giornata: serve quando si vuole rileggere per davvero. */
  invalida(matchday?: number): void {
    if (matchday === undefined) { this.cacheGlobale.clear(); return; }
    for (const k of [...this.cacheGlobale.keys()]) {
      if (k.endsWith(`:${matchday}`)) this.cacheGlobale.delete(k);
    }
  }

  private intestazioni(url: URL): Headers {
    const h = new Headers({ accept: 'application/json', ...this.profilo.headers });
    const auth = this.profilo.auth;
    if (auth.tipo === 'bearer') h.set('authorization', `Bearer ${this.chiave}`);
    else if (auth.tipo === 'header') h.set(auth.nome, this.chiave!);
    else if (auth.tipo === 'query') url.searchParams.set(auth.nome, this.chiave!);
    return h;
  }

  private async richiedi(id: string, endpoint: Endpoint, ctx: Contesto): Promise<unknown> {
    const url = new URL(riempi(endpoint.percorso, ctx), this.profilo.baseUrl);
    const chiaveCache = `${id}:${url.toString()}`;
    const intestazioni = this.intestazioni(url);
    const precedente = this.etag.get(chiaveCache);
    if (precedente) intestazioni.set('if-none-match', precedente);

    let ultimo: AdapterError | null = null;
    for (let tentativo = 1; tentativo <= this.tentativi; tentativo++) {
      try {
        this.diagnostica.richieste++;
        const risposta = await this.fetchImpl(url, {
          method: endpoint.metodo,
          headers: intestazioni,
          ...(endpoint.corpo ? { body: riempi(endpoint.corpo, ctx) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // 304: il servizio conferma che non e' cambiato niente. E' anche
        // l'informazione che serve alla macchina a stati — una lettura
        // identica alla precedente — quindi si restituisce l'ultimo corpo
        // invece di considerarla un guasto.
        if (risposta.status === 304) {
          const corpo = this.ultimoCorpo.get(chiaveCache);
          if (corpo !== undefined) {
            this.diagnostica.nonModificate++;
            return corpo;
          }
          // Un 304 senza niente in memoria: si richiede senza condizione.
          this.etag.delete(chiaveCache);
          intestazioni.delete('if-none-match');
          continue;
        }

        if (!risposta.ok) {
          const testo = await risposta.text().catch(() => '');
          const errore = erroreDaStato(risposta.status, this.profilo.fonte, testo);
          if (!errore.retryable) throw errore;
          ultimo = errore;
        } else {
          const grezzo = await this.leggiCorpo(risposta, id);
          const tag = risposta.headers.get('etag');
          if (tag) { this.etag.set(chiaveCache, tag); this.ultimoCorpo.set(chiaveCache, grezzo); }
          return grezzo;
        }
      } catch (e) {
        if (e instanceof AdapterError) {
          if (!e.retryable) throw e;
          ultimo = e;
        } else {
          // Timeout, DNS, connessione rifiutata: sono tutti riprovabili, e il
          // messaggio dell'eccezione non va mostrato cosi' com'e' perche' puo'
          // contenere l'URL completo, quindi la chiave se sta in query.
          const causa = e instanceof Error ? e.name : 'sconosciuto';
          ultimo = new AdapterError(
            `Non sono riuscito a contattare la fonte "${this.profilo.fonte}" (${causa}).`,
            'network', true,
          );
        }
      }

      if (tentativo < this.tentativi) {
        // Attesa che raddoppia: 500ms, 1s, 2s. Ritentare subito su un servizio
        // in affanno significa solo aggiungersi al carico che lo ha messo li'.
        await this.attesa(500 * 2 ** (tentativo - 1));
      }
    }

    throw ultimo ?? new AdapterError(
      `La fonte "${this.profilo.fonte}" non ha risposto.`, 'network', true,
    );
  }

  private async leggiCorpo(risposta: Response, id: string): Promise<unknown> {
    const lunghezza = Number(risposta.headers.get('content-length') ?? '0');
    if (lunghezza > MAX_BYTE_RISPOSTA) {
      throw new AdapterError(
        `La risposta per "${id}" supera il limite consentito.`, 'parse', false,
      );
    }
    const testo = await risposta.text();
    if (testo.length > MAX_BYTE_RISPOSTA) {
      throw new AdapterError(
        `La risposta per "${id}" supera il limite consentito.`, 'parse', false,
      );
    }
    try {
      return JSON.parse(testo);
    } catch {
      // Il caso piu' comune di tutti: una pagina di errore HTML servita con
      // stato 200. Dirlo cosi' fa risparmiare mezz'ora a chi legge il log.
      const inizio = testo.slice(0, 80).replace(/\s+/g, ' ').trim();
      throw new AdapterError(
        `La fonte "${this.profilo.fonte}" ha risposto qualcosa che non e' JSON per "${id}": ` +
        `«${inizio}». Probabile URL sbagliato o pagina di errore travestita da risposta buona.`,
        'parse', false,
      );
    }
  }

  /**
   * Scarica i payload di un piano.
   *
   * Il piano globale passa dalla cache di giornata; quello di lega no, perche'
   * per definizione cambia da lega a lega.
   */
  async payload(piano: 'globale' | 'lega', ctx: Contesto): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [id, endpoint] of Object.entries(this.profilo.endpoints)) {
      if (endpoint.piano !== piano) continue;

      if (piano === 'globale') {
        const chiave = `${id}:${ctx.season}:${ctx.matchday}`;
        const gia = this.cacheGlobale.get(chiave);
        if (gia !== undefined) { this.diagnostica.riusi++; out[id] = gia; continue; }
        const corpo = await this.prova(id, endpoint, ctx);
        if (corpo !== undefined) { this.cacheGlobale.set(chiave, corpo); out[id] = corpo; }
        continue;
      }

      const corpo = await this.prova(id, endpoint, ctx);
      if (corpo !== undefined) out[id] = corpo;
    }
    return out;
  }

  /** Un endpoint facoltativo che non risponde non ferma la giornata. */
  private async prova(id: string, endpoint: Endpoint, ctx: Contesto): Promise<unknown> {
    try {
      return await this.richiedi(id, endpoint, ctx);
    } catch (e) {
      if (endpoint.facoltativo && e instanceof AdapterError && e.kind === 'not-found') {
        return undefined;
      }
      throw e;
    }
  }

  /** Tutti i payload della giornata per una lega: i due piani insieme. */
  async payloadCompleti(ctx: Contesto): Promise<Record<string, unknown>> {
    const globali = await this.payload('globale', ctx);
    const lega = await this.payload('lega', ctx);
    return { ...globali, ...lega };
  }

  /** Il profilo, per passarlo ai costruttori condivisi. */
  get mappature() { return this.profilo.mappings; }
  get nome() { return this.profilo.fonte; }
  get versione() { return this.profilo.version; }
}

/* ------------------------------------------------------------------ */
/* Il ponte verso i costruttori condivisi                              */
/* ------------------------------------------------------------------ */

/**
 * Dai payload scaricati allo snapshot canonico.
 *
 * Riusa `importFromRelay`, cioe' esattamente il codice che serve l'estensione.
 * Non e' pigrizia: e' l'unica forma in cui la frase «le sorgenti convergono»
 * significa qualcosa. Se questo file avesse una sua costruzione parallela, il
 * giorno in cui una delle due cambia le due sorgenti darebbero giornali
 * diversi dagli stessi dati, e nessun test se ne accorgerebbe.
 */
export function importaDaHttp(
  payloads: Record<string, unknown>,
  fonte: FonteHttp,
  meta: { leagueId: string; leagueName: string; season: string; matchday: number },
): ReturnType<typeof importFromRelay> {
  return importFromRelay(
    {
      clientVersion: `http/${fonte.versione}`,
      platform: fonte.nome,
      // Diagnostico, non decisionale: la lega di destinazione la decide il
      // chiamante, che sa da quale configurazione e' partito.
      leagueExternalId: meta.leagueId,
      matchday: meta.matchday,
      season: meta.season,
      capturedAt: new Date().toISOString(),
      payloads,
    },
    {
      platform: fonte.nome,
      version: fonte.versione,
      // La fonte HTTP non guarda dentro un browser: `hosts` e `capture` sono
      // campi dell'estensione e qui non hanno significato. Restano riempiti
      // col minimo che lo schema accetta invece di allargare lo schema per
      // ospitare un caso che non esiste.
      hosts: ['http'],
      capture: [{ id: 'http', urlContains: '/' }],
      mappings: fonte.mappature,
    },
    { leagueId: meta.leagueId, leagueName: meta.leagueName, season: meta.season },
  );
}
