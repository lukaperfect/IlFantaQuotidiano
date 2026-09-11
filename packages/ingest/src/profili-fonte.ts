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
    endpoints: {
      voti: { percorso: '/voti?giornata={matchday}', piano: 'globale' },
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
 * Risolve un profilo per nome.
 *
 * `null` invece di un'eccezione: una lega configurata su un profilo che non
 * esiste piu' non deve far cadere l'intero tick delle altre.
 */
export function profiloFonte(nome: string, baseUrl: string | undefined): ProfiloFonte | null {
  if (nome === 'servizio-di-prova' && baseUrl) return profiloServizioDiProva(baseUrl);
  return null;
}
