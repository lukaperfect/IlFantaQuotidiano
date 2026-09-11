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
/**
 * GLI ORARI DI SERIE A DELLA GIORNATA, come li darebbe un servizio vero.
 *
 * `riferimento` e' l'istante attorno a cui si dispongono le partite, e va
 * passato di proposito invece di prendere «adesso»: e' cio' che decide quale
 * dei due numeri e' dovuto, quindi una verifica deve poterlo scegliere. Preso
 * implicitamente dall'orologio, la stessa verifica darebbe esiti diversi a
 * seconda dell'ora in cui gira — cioe' sarebbe verde di giorno e rossa la
 * notte.
 *
 * Il valore predefinito mette la giornata INTERAMENTE nel passato — non solo
 * il suo inizio. Ci ero cascato: con il riferimento a tre giorni fa e le
 * partite sparse su tre giorni, l'ULTIMA cadeva esattamente adesso, e il
 * retrospettivo non era ancora dovuto perche' esce la mattina dopo. Le
 * verifiche del percorso retrospettivo passavano da verdi a rosse in blocco, e
 * la causa non era nel pianificatore ma qui dentro.
 */
export function payloadPartite(
  snapshot: LeagueWeekSnapshot,
  riferimento: Date = new Date(Date.now() - 6 * 24 * 3600 * 1000),
): Record<string, unknown> {
  const base = riferimento.getTime();
  const squadre = [...new Set(
    snapshot.lineups.flatMap((l) => l.starters.map((s) => s.playerId.split('-')[0] ?? 'x')),
  )];
  // Una giornata sparsa su tre giorni, come una vera: venerdi', domenica,
  // lunedi'. Gli accoppiamenti non contano, contano gli orari.
  const quante = Math.max(2, Math.min(10, Math.ceil(squadre.length / 2)));
  const partite = Array.from({ length: quante }, (_, i) => ({
    inizio: new Date(base + Math.floor((i * 3) / Math.max(1, quante - 1)) * 24 * 3600 * 1000)
      .toISOString(),
    casa: `sa-${i * 2}`,
    trasferta: `sa-${i * 2 + 1}`,
  }));
  return { data: { partite } };
}

export function payloadPortaleDiProva(
  serieA: SerieAMatchday,
  snapshot: LeagueWeekSnapshot,
  opzioni: { riferimentoPartite?: Date } = {},
): Record<string, unknown> {
  return {
    voti: payloadVoti(serieA),
    partite: payloadPartite(snapshot, opzioni.riferimentoPartite),
    formazioni: payloadFormazioni(snapshot),
    calendario: payloadCalendario(snapshot),
    rose: payloadRose(snapshot),
    classifica: payloadClassifica(snapshot),
  };
}
