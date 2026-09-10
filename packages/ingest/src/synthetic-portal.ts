import type { LeagueWeekSnapshot, SerieAMatchday } from '@fantacomics/core';

/**
 * IL PORTALE DI PROVA.
 *
 * Genera i payload JSON che una piattaforma di fantacalcio *potrebbe*
 * plausibilmente servire: annidati, con nomi di campo in italiano e in un
 * dialetto tutto suo, cioe' proprio la forma che il profilo esiste per
 * normalizzare.
 *
 * Serve a due cose, ed e' importante che siano la stessa cosa: alimenta il
 * portale finto contro cui l'estensione viene verificata davvero in un
 * browser, e alimenta il test che dimostra che la stessa giornata, letta dal
 * relay o esportata in CSV, produce lo STESSO snapshot. Se fossero due
 * generatori diversi, quella dimostrazione non varrebbe niente.
 *
 * Vive nel pacchetto, accanto a `generateWorld`, per la stessa ragione: e'
 * un generatore di dati di sviluppo, e tenerlo altrove significherebbe
 * duplicarlo fra i test e il portale.
 */

export type PayloadPortale = Record<string, unknown>;

export function payloadVoti(serieA: SerieAMatchday): PayloadPortale {
  return {
    esito: 'ok',
    data: {
      giornata: serieA.matchday,
      giocatori: serieA.players.map((p) => ({
        id: p.playerId,
        nome: p.playerName,
        ruolo: p.role,
        squadra: p.serieATeam,
        stats: {
          // Il senza voto resta null: e' la distinzione che tutto il motore
          // di calcolo si porta dietro, e schiacciarla a zero qui la
          // perderebbe alla prima riga.
          voto: p.vote,
          minuti: p.minutes,
          gol: p.events.goals,
          autogol: p.events.ownGoals,
          assist: p.events.assists,
          rigoriSegnati: p.events.penaltiesScored,
          rigoriSbagliati: p.events.penaltiesMissed,
          rigoriParati: p.events.penaltiesSaved,
          ammonizioni: p.events.yellowCards,
          espulsioni: p.events.redCards,
          golSubiti: p.events.goalsConceded,
          xG: p.xG,
          fantavoto: p.officialFantaVote,
        },
      })),
    },
  };
}

export function payloadFormazioni(snapshot: LeagueWeekSnapshot): PayloadPortale {
  const teams = new Map(snapshot.teams.map((t) => [t.teamId, t]));
  const schieramenti: PayloadPortale[] = [];

  for (const lineup of snapshot.lineups) {
    const team = teams.get(lineup.teamId);
    const base = {
      squadraId: lineup.teamId,
      squadraNome: team?.teamName ?? lineup.teamId,
      presidente: team?.managerName ?? '',
      modulo: lineup.module,
      schieratoAuto: lineup.autoFilled,
    };
    lineup.starters.forEach((s, i) => schieramenti.push({
      ...base, slot: `T${i + 1}`, giocatoreId: s.playerId, ruolo: s.role,
      capitano: lineup.captainId === s.playerId,
    }));
    // L'ordine di panchina decide le sostituzioni: va servito, non dedotto.
    lineup.bench.forEach((s, i) => schieramenti.push({
      ...base, slot: `P${i + 1}`, giocatoreId: s.playerId, ruolo: s.role, capitano: false,
    }));
  }

  return { esito: 'ok', data: { schieramenti } };
}

export function payloadCalendario(snapshot: LeagueWeekSnapshot): PayloadPortale {
  return {
    esito: 'ok',
    data: {
      incontri: snapshot.fixtures.map((f) => ({
        casa: f.homeTeamId,
        trasferta: f.awayTeamId,
        puntiCasa: f.officialHomePoints,
        puntiTrasferta: f.officialAwayPoints,
        golCasa: f.officialHomeGoals,
        golTrasferta: f.officialAwayGoals,
      })),
    },
  };
}

export function payloadRose(snapshot: LeagueWeekSnapshot): PayloadPortale {
  const rose = snapshot.teams.flatMap((t) =>
    t.roster.map((r) => ({
      squadraId: t.teamId, giocatoreId: r.playerId, prezzo: r.purchasePrice,
    })),
  );
  return { esito: 'ok', data: { rose } };
}

export function payloadClassifica(snapshot: LeagueWeekSnapshot): PayloadPortale {
  return {
    esito: 'ok',
    data: {
      classifica: snapshot.standingsBefore.map((s) => ({
        squadraId: s.teamId,
        posizione: s.position,
        punti: s.points,
        fantapuntiTotali: s.totalFantasyPoints,
      })),
    },
  };
}

/** Tutti i payload, con le chiavi che il profilo di prova si aspetta. */
export function payloadPortaleDiProva(
  serieA: SerieAMatchday,
  snapshot: LeagueWeekSnapshot,
): Record<string, unknown> {
  return {
    voti: payloadVoti(serieA),
    formazioni: payloadFormazioni(snapshot),
    calendario: payloadCalendario(snapshot),
    rose: payloadRose(snapshot),
    classifica: payloadClassifica(snapshot),
  };
}
