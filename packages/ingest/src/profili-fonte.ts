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
 * IL PROFILO DELLA TESTATA CHE PUBBLICA I VOTI.
 *
 * Non e' un fornitore: e' un sito che si legge. La decisione e' commerciale e
 * sta a chi possiede il prodotto; qui c'e' solo il come, fatto nel modo meno
 * invasivo possibile — ci si presenta con un contatto, si rispetta il
 * robots.txt, e si legge UNA pagina per giornata per tutte le leghe insieme.
 *
 * LA GIORNATA STA NELL'INDIRIZZO, e la stagione con lei:
 * `/voti-fantacalcio-serie-a/2026-27/4`. Quel formato di stagione e' gia'
 * quello che `stagioneDi` produce, quindi i due segnaposto bastano e non
 * serve nessuna conversione.
 *
 * E LA PAGINA DEVE COMUNQUE DICHIARARE CHE GIORNATA E'. Non e' ridondanza:
 * un indirizzo puo' reindirizzare — alla giornata corrente, all'ultima
 * giocata — e chiedere la 4 ricevendo la 3 e' il difetto che nessun controllo
 * a valle puo' scoprire, perche' i numeri sarebbero coerenti, solo di
 * un'altra settimana. `campoGiornata` confronta cio' che si e' chiesto con
 * cio' che e' arrivato, e un disallineamento ferma tutto invece di pubblicare.
 *
 * IL LORO robots.txt CONSENTE QUESTA PAGINA. Verificato col nostro stesso
 * parser sul loro file vero, che sta in `__fixtures__/robots-fantacalcio.txt`
 * e su cui gira un test: il gruppo `*` vieta ricerca, preview, test e un paio
 * d'altre cose, non i voti, e non chiede nessuna attesa fra le richieste.
 * Vietare e' invece tutto per `ia_archiver`, che non siamo noi.
 *
 * DUE ENDPOINT SULLA STESSA PAGINA, QUINDI DUE LETTURE. Lo si e' accettato
 * invece di introdurre una cache per indirizzo: due letture per giornata sono
 * poca cosa, mentre intrecciare quella cache con la gestione del 304 e degli
 * ETag — che regge la macchina a stati — si paga con un rischio sproporzionato
 * al risparmio.
 *
 * I NOMI DEI CAMPI E I SELETTORI SONO STATI LETTI, NON INDOVINATI: vengono da
 * una pagina vera, di cui un ritaglio sta in `__fixtures__/voti-pagina.html` e
 * su cui girano i test. La prova che la lettura e' giusta e non solo
 * plausibile e' aritmetica: ricalcolando il fantavoto da voto e bonus con la
 * tabella standard, tornava su 285 giocatori su 285.
 */
export function profiloFantacalcioIt(): ProfiloFonte {
  /** Un bonus o un malus, letti dalla cella col titolo che il sito gli da'. */
  const bonus = (titolo: string) => ({
    selettore: `span.player-bonus[title="${titolo}"]`,
    da: 'attributo' as const, attributo: 'data-value', numero: true,
  });

  /**
   * Il cartellino sta nella CLASSE del voto, non in una colonna. Si traduce in
   * un contatore perche' i campi canonici contano i cartellini, e la cella
   * vuota significa «nessuno» — distinto da zero, che non vorrebbe dire nulla.
   */
  const cartellino = (quale: 'yellow-card' | 'red-card') => ({
    selettore: 'span.player-grade', indice: 0, da: 'classe' as const,
    estrai: `(${quale})`, mappa: { [quale]: '1' },
  });

  return ProfiloFonteSchema.parse({
    fonte: 'fantacalcio-it',
    version: 1,
    baseUrl: 'https://www.fantacalcio.it',
    identificazione: {
      prodotto: 'FantaComics',
      versione: '1.0',
      contatto: 'https://fantacomics.it/bot',
    },
    // Si legge una pagina per giornata: l'attesa fra le richieste e' ampia
    // perche' non c'e' nessuna fretta e la cortesia costa zero.
    attesaMinimaMs: 2000,
    endpoints: {
      voti: {
        percorso: '/voti-fantacalcio-serie-a/{season}/{matchday}',
        piano: 'globale',
        estrazione: 'dom',
        campoGiornata: 'giornata',
        selettori: {
          documento: {
            giornata: {
              selettore: 'select#matchweek option[selected]',
              da: 'attributo', attributo: 'value', numero: true,
            },
          },
          gruppo: {
            selettore: 'li.team-table',
            campi: { squadra: { selettore: 'a.team-name' } },
          },
          // `:has` esclude la riga dell'allenatore: prende un voto ma in una
          // rosa di fantacalcio non c'e', e un identificatore non ce l'ha.
          riga: 'tbody tr:has(a.player-name)',
          campi: {
            idGiocatore: {
              selettore: 'a.player-name', da: 'attributo', attributo: 'href',
              estrai: '/(\\d+)$',
            },
            nome: { selettore: 'a.player-name' },
            ruolo: {
              selettore: 'span.role', da: 'attributo', attributo: 'data-value',
              mappa: { p: 'P', d: 'D', c: 'C', a: 'A' },
            },
            /**
             * Il voto della redazione, che e' la prima delle tre colonne. Le
             * altre due — statistico e «Italia» — restano disponibili come
             * indice 1 e 2: quale faccia fede e' una scelta della lega, cioe'
             * un dato di questo profilo, non del codice.
             *
             * `55` NON e' 5,5: e' «senza voto». La prova sta nei giocatori
             * ammoniti che hanno 55: il giallo non toglie mezzo punto perche'
             * non c'e' voto a cui toglierlo, mentre lo toglie in tutti gli
             * altri 285 casi.
             */
            voto: {
              selettore: 'span.player-grade', indice: 0,
              da: 'attributo', attributo: 'data-value', vuotoSe: ['55'], numero: true,
            },
            fantavoto: {
              selettore: 'span.player-fanta-grade', indice: 0,
              da: 'attributo', attributo: 'data-value', vuotoSe: ['55'], numero: true,
            },
            ammonizione: cartellino('yellow-card'),
            espulsione: cartellino('red-card'),
            gol: bonus('Gol segnati'),
            golSubiti: bonus('Gol subiti'),
            autoreti: bonus('Autoreti'),
            rigoriSegnati: bonus('Rigori segnati'),
            rigoriSbagliati: bonus('Rigori sbagliati'),
            rigoriParati: bonus('Rigori parati'),
            assist: bonus('Assist'),
          },
        },
      },
      /**
       * GLI ORARI, dalla stessa pagina. Sono quelli che decidono quale dei due
       * numeri della settimana e' dovuto, e senza di loro la vigilia non
       * uscirebbe da sola.
       *
       * Una riga per PARTITA e non per squadra: ogni incontro compare in due
       * tabelle, e prenderle entrambe darebbe venti partite dove ce ne sono
       * dieci. Si tengono le tabelle in cui la squadra di casa e' quella della
       * tabella, che il sito marca con `current` sul primo nome.
       */
      partite: {
        percorso: '/voti-fantacalcio-serie-a/{season}/{matchday}',
        piano: 'globale',
        facoltativo: true,
        estrazione: 'dom',
        campoGiornata: 'giornata',
        selettori: {
          documento: {
            giornata: {
              selettore: 'select#matchweek option[selected]',
              da: 'attributo', attributo: 'value', numero: true,
            },
          },
          riga: 'li.team-table:has(.match-score span:first-child.current)',
          campi: {
            casa: { selettore: '.match-score span', indice: 0 },
            trasferta: { selettore: '.match-score span', indice: 4 },
            /**
             * «05/09/2026 - 20:45» va ricomposto e ancorato a un fuso. Dato a
             * un parser cosi' com'e' diventerebbe il 9 maggio in mezzo mondo —
             * e il 9 maggio e' una data valida, quindi passerebbe.
             */
            inizio: {
              selettore: '.match-date',
              estrai: '(\\d{2})/(\\d{2})/(\\d{4}) - (\\d{2}):(\\d{2})',
              componi: '$3-$2-$1T$4:$5',
              fuso: 'Europe/Rome',
            },
          },
        },
      },
    },
    /**
     * `root: "$"` perche' l'estrazione dal DOM restituisce gia' l'elenco delle
     * righe: non c'e' nessun involucro da attraversare.
     *
     * Cio' che NON c'e' e' dichiarato dalla sua assenza: i MINUTI giocati. La
     * pagina non li pubblica. Non e' un buco che pesa, ed e' stato verificato
     * invece che sperato: il motore decide le sostituzioni automatiche su
     * «senza voto», e la macchina a stati riconosce una giornata finita dal
     * fatto che ogni squadra scesa in campo ha dei voti — nessuno dei due
     * guarda i minuti.
     */
    mappings: {
      voti: {
        version: 1,
        root: '$',
        fields: {
          playerId: 'idGiocatore', playerName: 'nome', role: 'ruolo',
          serieATeam: 'squadra', vote: 'voto', officialFantaVote: 'fantavoto',
          goals: 'gol', goalsConceded: 'golSubiti', ownGoals: 'autoreti',
          penaltiesScored: 'rigoriSegnati', penaltiesMissed: 'rigoriSbagliati',
          penaltiesSaved: 'rigoriParati', assists: 'assist',
          yellowCards: 'ammonizione', redCards: 'espulsione',
        },
      },
      partite: {
        version: 1,
        root: '$',
        fields: { kickoff: 'inizio', homeTeam: 'casa', awayTeam: 'trasferta' },
      },
    },
  });
}

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

  if (nome === 'fantacalcio-it') return profiloFantacalcioIt();
  if (nome === 'servizio-di-prova' && baseUrl) return profiloServizioDiProva(baseUrl);
  return null;
}
