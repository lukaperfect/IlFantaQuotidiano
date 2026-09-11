import { ProfiloFonteSchema, type ProfiloFonte } from './collectors/http-fonte.js';

/**
 * I PROFILI DELLE FONTI HTTP.
 *
 * Come i profili di piattaforma dell'estensione, sono DATI. Stanno in un file
 * versionato perche' un valore predefinito deve pur stare da qualche parte; in
 * esercizio arrivano dal database e si correggono senza rilasciare niente.
 * E' la proprieta' che rende un cambio di fornitore una riga di
 * configurazione invece di un rilascio.
 *
 * NOTA ONESTA, E VA LETTA PRIMA DI COLLEGARE QUALUNQUE COSA.
 *
 * I due piani del progetto hanno disponibilita' MOLTO diverse, e confonderli
 * porta a pianificare qualcosa che non esiste.
 *
 * Il piano GLOBALE — cosa e' successo in Serie A: chi ha giocato, quanti
 * minuti, gol, ammonizioni — e' pubblico nel senso che esistono fornitori che
 * lo vendono, ed e' esattamente il caso d'uso di questo modulo. Attenzione
 * pero' al voto: il *voto* del fantacalcio non e' un dato di cronaca, e' un
 * giudizio redazionale di una testata. Un servizio di statistiche sportive
 * fornisce gli eventi, non necessariamente il voto — e senza voto il fantavoto
 * si puo' solo stimare, il che e' un prodotto diverso e va detto all'utente
 * invece che scoperto da lui.
 *
 * Il piano DELLA LEGA — chi ha schierato chi questa settimana, il calendario
 * degli scontri — e' dato PRIVATO dentro la lega dell'utente. Nessun servizio
 * terzo ce l'ha, perche' non e' suo: esiste solo dietro le credenziali del
 * proprietario. Per quello la strada e' l'estensione, che legge nella sessione
 * gia' autenticata dell'utente senza custodirne le credenziali, oppure
 * un'eventuale API ufficiale della piattaforma a cui l'utente abbia accesso.
 *
 * Per questo `piano` e' una proprieta' di ogni endpoint e non della fonte
 * intera: un profilo puo' benissimo prendere il globale da un servizio e
 * lasciare il piano della lega all'estensione.
 */

/**
 * Il profilo del servizio di prova che accompagna la verifica end-to-end.
 * URL e nomi dei campi sono quelli che controllo io: e' il banco di prova
 * della catena, non un fornitore vero.
 */
export function profiloServizioDiProva(baseUrl: string): ProfiloFonte {
  return ProfiloFonteSchema.parse({
    fonte: 'servizio-di-prova',
    version: 1,
    baseUrl,
    /**
     * Il servizio di prova e' il MIO server, alzato dalla verifica stessa.
     * Chiedergli il robots.txt sarebbe chiedere il permesso a me stesso, e
     * aggiungerebbe una richiesta a ogni conteggio senza dire niente a
     * nessuno. Lo si dichiara qui, esplicitamente, invece di dedurlo da
     * qualche regola implicita: un profilo che non rispetta robots.txt deve
     * dire perche'.
     */
    rispettaRobots: false,
    endpoints: {
      voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' },
      /**
       * GLI ORARI DI SERIE A. Piano globale: sono gli stessi per tutte le
       * leghe, ed e' da loro che discende QUANDO escono i due numeri della
       * settimana. Facoltativo: senza, il pianificatore ricade sulla macchina
       * a stati invece di non pubblicare piu' niente.
       */
      partite: { percorso: '/partite?giornata={matchday}', piano: 'globale', facoltativo: true },
      formazioni: {
        percorso: '/formazioni?lega={leagueExternalId}&g={matchday}', piano: 'lega',
      },
      calendario: {
        percorso: '/calendario?lega={leagueExternalId}&g={matchday}', piano: 'lega',
      },
      rose: { percorso: '/rose?lega={leagueExternalId}', piano: 'lega', facoltativo: true },
      classifica: {
        percorso: '/classifica?lega={leagueExternalId}', piano: 'lega', facoltativo: true,
      },
    },
    mappings: {
      voti: {
        version: 1,
        root: 'data.giocatori',
        fields: {
          playerId: 'id', playerName: 'nome', role: 'ruolo', serieATeam: 'squadra',
          vote: 'stats.voto', minutes: 'stats.minuti', goals: 'stats.gol',
          ownGoals: 'stats.autogol', assists: 'stats.assist',
          penaltiesScored: 'stats.rigoriSegnati', penaltiesMissed: 'stats.rigoriSbagliati',
          penaltiesSaved: 'stats.rigoriParati', yellowCards: 'stats.ammonizioni',
          redCards: 'stats.espulsioni', goalsConceded: 'stats.golSubiti',
          xG: 'stats.xG', officialFantaVote: 'stats.fantavoto',
        },
      },
      partite: {
        version: 1,
        root: 'data.partite',
        fields: { kickoff: 'inizio', homeTeam: 'casa', awayTeam: 'trasferta' },
      },
      formazioni: {
        version: 1,
        root: 'data.schieramenti',
        fields: {
          teamId: 'squadraId', teamName: 'squadraNome', managerName: 'presidente',
          module: 'modulo', position: 'slot', playerId: 'giocatoreId', role: 'ruolo',
          captain: 'capitano', autoFilled: 'schieratoAuto',
        },
      },
      calendario: {
        version: 1,
        root: 'data.incontri',
        fields: {
          homeTeamId: 'casa', awayTeamId: 'trasferta',
          officialHomePoints: 'puntiCasa', officialAwayPoints: 'puntiTrasferta',
          officialHomeGoals: 'golCasa', officialAwayGoals: 'golTrasferta',
        },
      },
      rose: {
        version: 1,
        root: 'data.rose',
        fields: { teamId: 'squadraId', playerId: 'giocatoreId', purchasePrice: 'prezzo' },
      },
      classifica: {
        version: 1,
        root: 'data.classifica',
        fields: {
          teamId: 'squadraId', position: 'posizione', points: 'punti',
          totalFantasyPoints: 'totaleFantapunti',
        },
      },
    },
  });
}

/**
 * I PROFILI CONFIGURATI, presi dall'ambiente.
 *
 * E' la promessa che questo file fa fin dalla prima riga — «in esercizio
 * arrivano dal database e si correggono senza rilasciare niente» — e che
 * finora non era mantenuta: `profiloFonte` conosceva solo il servizio di
 * prova, quindi collegare una fonte vera richiedeva comunque un rilascio.
 *
 * Il formato e' un oggetto JSON da nome a profilo:
 *
 *     FANTACOMICS_PROFILI_FONTE='{"il-sito": { "fonte": "il-sito", ... }}'
 *
 * Si valida con lo STESSO schema dei profili interni, e un profilo malformato
 * lancia qui — all'avvio, quando qualcuno sta guardando — invece di fallire
 * alla prima giornata da consegnare.
 */
export function profiliDaAmbiente(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ProfiloFonte> {
  const grezzo = env.FANTACOMICS_PROFILI_FONTE;
  if (!grezzo) return {};

  let letto: unknown;
  try {
    letto = JSON.parse(grezzo);
  } catch (e) {
    throw new Error(
      'FANTACOMICS_PROFILI_FONTE non e\' JSON valido: '
      + (e instanceof Error ? e.message : 'errore sconosciuto'),
    );
  }
  if (letto === null || typeof letto !== 'object' || Array.isArray(letto)) {
    throw new Error(
      'FANTACOMICS_PROFILI_FONTE dev\'essere un oggetto da nome del profilo a profilo.',
    );
  }

  const out: Record<string, ProfiloFonte> = {};
  for (const [nome, valore] of Object.entries(letto as Record<string, unknown>)) {
    const esito = ProfiloFonteSchema.safeParse(valore);
    if (!esito.success) {
      throw new Error(
        `Il profilo di fonte "${nome}" non e' valido: `
        + esito.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    out[nome] = esito.data;
  }
  return out;
}

/**
 * Risolve un profilo per nome.
 *
 * L'ordine e' CONFIGURAZIONE PRIMA, incorporati dopo: e' quello che permette di
 * correggere un profilo in produzione senza aspettare un rilascio, ed e' anche
 * quello che permette di sovrascrivere il servizio di prova quando serve.
 *
 * `null` invece di un'eccezione: una lega configurata su un profilo che non
 * esiste piu' non deve far cadere l'intero tick delle altre.
 */
export function profiloFonte(
  nome: string,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProfiloFonte | null {
  const configurati = profiliDaAmbiente(env);
  const dallAmbiente = configurati[nome];
  if (dallAmbiente) return dallAmbiente;

  if (nome === 'servizio-di-prova' && baseUrl) return profiloServizioDiProva(baseUrl);
  return null;
}
