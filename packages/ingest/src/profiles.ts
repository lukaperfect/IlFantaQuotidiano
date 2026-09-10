import { PlatformProfileSchema, type PlatformProfile } from './collectors/relay-import.js';

/**
 * I PROFILI DI PIATTAFORMA.
 *
 * Sono DATI, non codice, e stanno qui solo perche' un file versionato e' il
 * posto giusto dove tenere un valore predefinito. In esercizio il profilo
 * arriva dal database e si aggiorna senza rilasciare niente: e' la proprieta'
 * che rende una deriva della piattaforma un intervento di configurazione da
 * cinque minuti invece di un rilascio dell'estensione seguito dall'attesa che
 * gli utenti aggiornino — attesa che, su un prodotto settimanale, significa
 * saltare una o due giornate.
 *
 * NOTA ONESTA SUI NOMI DEI CAMPI. Il profilo qui sotto e' quello del portale
 * di prova che accompagna la verifica dell'estensione: URL e nomi dei campi
 * sono quelli che controllo io. Il profilo della piattaforma vera richiede di
 * osservare le sue risposte reali, ed e' l'unica cosa che manca — ma e'
 * esattamente la parte progettata per essere un dato. Tutto il resto della
 * catena (intercettazione, mappatura, copertura, costruzione dello snapshot)
 * e' identico e verificato end-to-end.
 */

export const PROFILO_PROVA: PlatformProfile = PlatformProfileSchema.parse({
  platform: 'portale-di-prova',
  version: 1,
  hosts: ['localhost', '127.0.0.1'],
  capture: [
    { id: 'voti', urlContains: '/api/voti' },
    { id: 'formazioni', urlContains: '/api/formazioni' },
    { id: 'calendario', urlContains: '/api/calendario' },
    { id: 'rose', urlContains: '/api/rose' },
    { id: 'classifica', urlContains: '/api/classifica' },
  ],
  mappings: {
    voti: {
      version: 1,
      root: 'data.giocatori',
      fields: {
        playerId: 'id',
        playerName: 'nome',
        role: 'ruolo',
        serieATeam: 'squadra',
        vote: 'stats.voto',
        minutes: 'stats.minuti',
        goals: 'stats.gol',
        ownGoals: 'stats.autogol',
        assists: 'stats.assist',
        penaltiesScored: 'stats.rigoriSegnati',
        penaltiesMissed: 'stats.rigoriSbagliati',
        penaltiesSaved: 'stats.rigoriParati',
        yellowCards: 'stats.ammonizioni',
        redCards: 'stats.espulsioni',
        goalsConceded: 'stats.golSubiti',
        xG: 'stats.xG',
        officialFantaVote: 'stats.fantavoto',
      },
    },
    formazioni: {
      version: 1,
      root: 'data.schieramenti',
      fields: {
        teamId: 'squadraId',
        teamName: 'squadraNome',
        managerName: 'presidente',
        module: 'modulo',
        position: 'slot',
        playerId: 'giocatoreId',
        role: 'ruolo',
        captain: 'capitano',
        autoFilled: 'schieratoAuto',
      },
    },
    calendario: {
      version: 1,
      root: 'data.incontri',
      fields: {
        homeTeamId: 'casa',
        awayTeamId: 'trasferta',
        officialHomePoints: 'puntiCasa',
        officialAwayPoints: 'puntiTrasferta',
        officialHomeGoals: 'golCasa',
        officialAwayGoals: 'golTrasferta',
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
        totalFantasyPoints: 'fantapuntiTotali',
      },
    },
  },
});

export const PROFILI: Record<string, PlatformProfile> = {
  [PROFILO_PROVA.platform]: PROFILO_PROVA,
};

export function profiloDi(platform: string): PlatformProfile | null {
  return PROFILI[platform] ?? null;
}
