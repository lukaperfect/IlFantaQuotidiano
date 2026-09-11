import { stableHash } from '@fantacomics/core';
import {
  FonteHttp, importaDaHttp, osservazioneDaGiornata, applyMapping,
  AdapterError, type Observation,
} from '@fantacomics/ingest';
import type { FonteGiornata } from './scheduler.js';
import type { LeagueConfig, LeagueStore } from './store.js';

/**
 * LA FONTE HTTP COME SORGENTE DEL PIANIFICATORE.
 *
 * E' il pezzo che chiude il cerchio: il cron scatta, questa chiede al servizio,
 * la macchina a stati guarda se la giornata e' finita e la pipeline pubblica.
 * Nessuno carica niente.
 *
 * Le due domande restano separate, come dal primo giorno. Il cron decide
 * QUANDO CHIEDERE; questa fonte non decide niente, si limita a leggere e a
 * registrare cio' che ha letto. Chi dichiara pronta la giornata e' la macchina
 * a stati, sulla base delle osservazioni accumulate — ed e' per questo che
 * `osservazioni()` le prende dallo STORE e non da una variabile in memoria:
 * un processo di cron che parte, legge e termina non accumulerebbe mai nulla,
 * e la giornata non sarebbe dichiarata pronta mai.
 */

export type OpzioniFonteGiornata = {
  http: FonteHttp;
  store: LeagueStore;
  season: string;
  now?: () => Date;
};

/** Dove il servizio tiene l'identificatore della lega. */
export function identificativoEsterno(config: LeagueConfig): string | null {
  return config.fonte?.leagueExternalId ?? null;
}

export function creaFonteGiornata(opzioni: OpzioniFonteGiornata): FonteGiornata {
  const { http, store, season } = opzioni;
  const adesso = opzioni.now ?? (() => new Date());

  return {
    /**
     * Cio' che sappiamo senza spendere una richiesta: solo lo store.
     *
     * E' la meta' economica del mestiere di questa fonte. L'altra, qui sotto,
     * costa una chiamata al servizio.
     */
    async storiche(matchday: number): Promise<readonly Observation[]> {
      return store.getOsservazioni(season, matchday);
    },

    /**
     * Legge il piano globale e registra cio' che ha visto.
     *
     * Il valore restituito include l'osservazione appena presa, perche' la
     * macchina a stati vuole la storia con la lettura corrente in fondo.
     */
    async osservazioni(matchday: number): Promise<readonly Observation[]> {
      const globali = await http.payload('globale', { matchday, season });
      const grezzo = globali.voti;
      if (grezzo === undefined) {
        throw new AdapterError(
          `La fonte "${http.nome}" non ha restituito i voti della giornata ${matchday}.`,
          'not-found', true,
        );
      }

      const mappatura = http.mappature.voti;
      if (!mappatura) {
        throw new AdapterError(
          `Il profilo "${http.nome}" non mappa i voti: senza, non posso sapere se la ` +
          'giornata e\' finita.', 'parse', false,
        );
      }

      const estratti = applyMapping(grezzo, mappatura);
      const giocatori = estratti.map((r) => ({
        serieATeam: String(r.serieATeam ?? 'N/D'),
        playerId: String(r.playerId ?? ''),
        // Cella vuota = senza voto. E' un'informazione, non uno zero: e'
        // esattamente la distinzione su cui poggia il segnale strutturale.
        vote: r.vote === null || r.vote === undefined || r.vote === ''
          ? null
          : Number(r.vote),
        minuti: Number(r.minutes ?? 0) || 0,
      }));

      /**
       * IL SECONDO CANCELLO, E PERCHE' QUI SERVE DAVVERO.
       *
       * Il controllo strutturale — una squadra che non ha giocato non ha
       * nessun voto — e' quello forte, ma da solo non basta su questo
       * percorso. I voti si pubblicano a poco a poco, e appena OGNI squadra ha
       * il suo primo voto il controllo strutturale passa: misurato, con il 20%
       * dei voti distribuiti su tutte le squadre il cancello si apre mentre i
       * voti sono ancora meno di un quinto. Uscirebbe un giornale con nove
       * decimi dei giocatori senza voto, e la riconciliazione non se ne
       * accorgerebbe — i punteggi ufficiali parziali tornano benissimo con
       * quelli parziali ricalcolati.
       *
       * IL DENOMINATORE GIUSTO E' CHI E' SCESO IN CAMPO. Non tutti i
       * tesserati, perche' chi non gioca legittimamente non ha voto e la quota
       * risulterebbe bassa anche a giornata finita — e' l'errore che ho gia'
       * fatto una volta con i titolari. Chi ha giocato dei minuti invece un
       * voto ce l'ha per definizione: e' la promessa stessa di chi i voti li
       * pubblica. Per questo qui la soglia alta e' giustificata invece che
       * indovinata.
       */
      const conMinuti = giocatori.filter((g) => g.minuti > 0);
      const conVoto = giocatori.filter((g) => g.vote !== null);
      if (conVoto.length > 0 && conMinuti.length === 0) {
        // Senza minuti quel cancello non e' calcolabile, e resterebbe chiuso
        // per sempre senza dire perche'. Un blocco silenzioso e' peggio di un
        // errore: si dice qual e' il campo che manca.
        throw new AdapterError(
          `La fonte "${http.nome}" pubblica voti ma nessun minuto giocato. Senza i minuti ` +
          'non posso distinguere una giornata finita da una con i voti ancora in arrivo: ' +
          'controlla che la mappatura dei voti includa il campo "minutes".',
          'parse', false,
        );
      }

      // La parte strutturale resta quella misurata e gia' verificata: si
      // riusa invece di riscriverne una copia che un giorno divergerebbe.
      const strutturale = osservazioneDaGiornata(giocatori, [], {
        fetchedAt: adesso().toISOString(),
        // L'hash sta sul payload GREZZO: cambia anche se cambia solo la
        // mappatura, ed e' cio' che serve per accorgersi che la stessa
        // giornata e' stata riletta diversamente.
        contentHash: stableHash(JSON.stringify(grezzo)),
      });

      const osservazione: Observation = {
        fetchedAt: strutturale.fetchedAt,
        contentHash: strutturale.contentHash,
        matchesFinished: strutturale.matchesFinished,
        matchesTotal: strutturale.matchesTotal,
        playersRated: conMinuti.filter((g) => g.vote !== null).length,
        playersExpected: conMinuti.length,
      };

      /**
       * Si registra OGNI lettura, anche identica alla precedente.
       *
       * Sembrava piu' pulito non ripetere righe uguali, ed era un difetto
       * grosso: la politica chiede «due letture consecutive identiche», quindi
       * una storia deduplicata non raggiunge mai il conto e la giornata non
       * verrebbe dichiarata pronta MAI. Due passate del cron su un contenuto
       * uguale sono esattamente la prova che i voti si sono fermati — e' il
       * dato, non rumore da togliere.
       */
      await store.appendOsservazione(season, matchday, osservazione);
      return store.getOsservazioni(season, matchday);
    },

    /**
     * Il materiale della lega. `null` quando questa lega non passa da qui —
     * non e' un errore: puo' usare l'estensione, o non essere ancora
     * collegata.
     */
    async materiale(config: LeagueConfig, matchday: number) {
      const esterno = identificativoEsterno(config);
      if (esterno === null) return null;

      const payloads = await http.payloadCompleti({
        matchday, season, leagueExternalId: esterno,
      });

      const { serieA, snapshot } = importaDaHttp(payloads, http, {
        leagueId: config.leagueId,
        leagueName: config.leagueName,
        season,
        matchday,
      });
      return { serieA, snapshot };
    },
  };
}
