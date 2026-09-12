import { describe, it, expect } from 'vitest';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { computeLeagueMatchday } from '@fantacomics/scoring';
import { parseCsv, parseCsvTable } from './csv.js';
import { generateWorld, withOfficialScores, nudgeTeamToScore } from './synthetic.js';
import { exportAll } from './collectors/file-export.js';
import { importFromFiles } from './collectors/file-import.js';
import { evaluateReadiness, shouldDeliver, type Observation } from './readiness.js';
import { detectDrift, describeShape, formatDriftReport } from './validation.js';
import { resolvePath, applyMapping, parseEnvelope, mappingCoverage } from './collectors/extension-relay.js';
import { AdapterError, AdapterRegistry } from './adapter.js';
import { importFromRelay, recordsFromEnvelope, coperturaMinima } from './collectors/relay-import.js';
import { PROFILO_PROVA } from './profiles.js';
import {
  osservazioneDaGiornata, POLITICA_LETTURA_SINGOLA, evaluateReadiness as valuta,
} from './readiness.js';
import { payloadPortaleDiProva } from './synthetic-portal.js';

const R = DEFAULT_RULESET;

describe('parser CSV', () => {
  it('gestisce virgolette, virgole interne e virgolette raddoppiate', () => {
    expect(parseCsv('a,"b,c","d""e"')).toEqual([['a', 'b,c', 'd"e']]);
  });

  it('accetta il punto e virgola e il BOM di Excel', () => {
    expect(parseCsvTable('﻿x;y\n1;2').rows[0]).toEqual({ x: '1', y: '2' });
  });

  it('ignora le righe vuote e i CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
});

describe('round-trip export → import', () => {
  function world() {
    let w = generateWorld({ seed: 'roundtrip', teams: 8, matchday: 12, scenarios: { formazioneNonSchierata: true } });
    w = nudgeTeamToScore(w, 't1', 71.5, R);
    return withOfficialScores(w, R);
  }

  it('reimportare i CSV riproduce esattamente gli stessi punteggi', () => {
    const original = world();
    const files = exportAll(original.serieA, original.snapshot);
    const reimported = importFromFiles({
      season: original.snapshot.season,
      matchday: original.snapshot.matchday,
      leagueId: original.snapshot.leagueId,
      leagueName: original.snapshot.leagueName,
      collectedAt: original.snapshot.collectedAt,
      ...files,
    });

    const before = computeLeagueMatchday(original.snapshot, original.serieA, R);
    const after = computeLeagueMatchday(reimported.snapshot, reimported.serieA, R);

    expect(after.reconciliation.ok).toBe(true);
    for (const [teamId, score] of before.scores) {
      expect(after.scores.get(teamId)?.total, teamId).toBe(score.total);
      expect(after.scores.get(teamId)?.goals, teamId).toBe(score.goals);
    }
  });

  it('conserva l’ordine di panchina, che determina le sostituzioni', () => {
    const original = world();
    const files = exportAll(original.serieA, original.snapshot);
    const reimported = importFromFiles({
      season: '2025-26', matchday: 12, leagueId: 'l', leagueName: 'L', ...files,
    });
    for (const lineup of original.snapshot.lineups) {
      const back = reimported.snapshot.lineups.find((l) => l.teamId === lineup.teamId);
      expect(back?.bench.map((b) => b.playerId), lineup.teamId).toEqual(lineup.bench.map((b) => b.playerId));
      expect(back?.starters.map((b) => b.playerId), lineup.teamId).toEqual(lineup.starters.map((b) => b.playerId));
    }
  });

  it('conserva il flag di formazione non schierata', () => {
    const original = world();
    const files = exportAll(original.serieA, original.snapshot);
    const back = importFromFiles({ season: '2025-26', matchday: 12, leagueId: 'l', leagueName: 'L', ...files });
    const autoOriginal = original.snapshot.lineups.filter((l) => l.autoFilled).map((l) => l.teamId).sort();
    const autoBack = back.snapshot.lineups.filter((l) => l.autoFilled).map((l) => l.teamId).sort();
    expect(autoBack).toEqual(autoOriginal);
    expect(autoBack.length).toBeGreaterThan(0);
  });

  it('distingue una cella vuota da uno zero: la vuota è un SV', () => {
    const back = importFromFiles({
      season: '2025-26', matchday: 1, leagueId: 'l', leagueName: 'L',
      votiCsv: 'playerId,playerName,role,serieATeam,vote\np1,Tizio,A,MIL,\np2,Caio,A,MIL,0',
      formazioniCsv: minimalLineup(),
      calendarioCsv: 'homeTeamId,awayTeamId\nt1,t2',
    });
    expect(back.serieA.players.find((p) => p.playerId === 'p1')?.vote).toBeNull();
    expect(back.serieA.players.find((p) => p.playerId === 'p2')?.vote).toBe(0);
  });
});

function minimalLineup(teamIds = ['t1', 't2']): string {
  const rows = ['teamId,teamName,managerName,module,position,playerId,role'];
  for (const t of teamIds) {
    const roles = ['P', 'D', 'D', 'D', 'C', 'C', 'C', 'C', 'A', 'A', 'A'];
    roles.forEach((role, i) => rows.push(`${t},Squadra ${t},Mario,3-4-3,T${i + 1},${t}-p${i + 1},${role}`));
  }
  return rows.join('\n');
}

describe('errori di importazione', () => {
  const base = {
    season: '2025-26', matchday: 1, leagueId: 'l', leagueName: 'L',
    votiCsv: 'playerId,playerName,role,serieATeam,vote\np1,Tizio,A,MIL,6',
  };

  it('rifiuta una formazione che non ha 11 titolari', () => {
    expect(() => importFromFiles({
      ...base,
      formazioniCsv: 'teamId,teamName,managerName,module,position,playerId,role\nt1,A,M,3-4-3,T1,p1,P',
      calendarioCsv: 'homeTeamId,awayTeamId\nt1,t2',
    })).toThrow(/1 titolari invece di 11/);
  });

  it('rifiuta un calendario che cita una squadra sconosciuta', () => {
    expect(() => importFromFiles({
      ...base,
      formazioniCsv: minimalLineup(['t1']),
      calendarioCsv: 'homeTeamId,awayTeamId\nt1,t9',
    })).toThrow(/"t9" che non compare/);
  });

  it('rifiuta un ruolo non valido indicando la riga', () => {
    expect(() => importFromFiles({
      ...base,
      votiCsv: 'playerId,playerName,role,serieATeam,vote\np1,Tizio,Z,MIL,6',
      formazioniCsv: minimalLineup(),
      calendarioCsv: 'homeTeamId,awayTeamId\nt1,t2',
    })).toThrow(/Ruolo non valido "Z" \(voti riga 2\)/);
  });

  it('rifiuta file vuoti con un messaggio comprensibile', () => {
    expect(() => importFromFiles({ ...base, votiCsv: '', formazioniCsv: '', calendarioCsv: '' }))
      .toThrow(/voti è vuoto/);
  });
});

describe('macchina a stati della giornata', () => {
  const obs = (over: Partial<Observation> = {}): Observation => ({
    fetchedAt: '2026-01-05T22:00:00+01:00', contentHash: 'h1',
    matchesFinished: 10, matchesTotal: 10, playersRated: 190, playersExpected: 200, ...over,
  });

  it('non dichiara pronta una giornata con partite da giocare', () => {
    const d = evaluateReadiness([obs({ matchesFinished: 9 })]);
    expect(d.ready).toBe(false);
    expect(d.state).toBe('GIORNATA_APERTA');
    expect(d.reason).toMatch(/posticipi|infrasettimanale/);
    // Manca una partita intera: non ha senso ripassare fra un minuto.
    expect(d.recheckAfterSeconds).toBeGreaterThanOrEqual(3600);
  });

  it('non dichiara pronta una giornata con voti incompleti', () => {
    const d = evaluateReadiness([obs({ playersRated: 100 })]);
    expect(d.ready).toBe(false);
    expect(d.state).toBe('VOTI_PARZIALI');
  });

  it('pretende due letture identiche prima di dichiarare stabili i voti', () => {
    expect(evaluateReadiness([obs({ contentHash: 'a' })]).ready).toBe(false);
    expect(evaluateReadiness([obs({ contentHash: 'a' }), obs({ contentHash: 'b' })]).ready).toBe(false);
    const stabile = evaluateReadiness([obs({ contentHash: 'a' }), obs({ contentHash: 'a' })]);
    expect(stabile.ready).toBe(true);
    expect(stabile.state).toBe('VOTI_DEFINITIVI');
  });

  it('gestisce l’assenza di osservazioni', () => {
    expect(evaluateReadiness([]).ready).toBe(false);
  });

  it('consegna dentro la finestra e non prima', () => {
    const pronta = evaluateReadiness([obs(), obs()]);
    const martedi9 = new Date('2026-01-06T09:30:00+01:00');
    const martedi7 = new Date('2026-01-06T07:00:00+01:00');
    expect(shouldDeliver(pronta, martedi9).deliver).toBe(true);
    expect(shouldDeliver(pronta, martedi7).deliver).toBe(false);
  });

  it('consegna subito una giornata pronta in ritardo, invece di perderla', () => {
    // Un posticipo chiude mercoledì: aspettare il martedì dopo significa
    // non consegnare mai quella giornata.
    const pronta = evaluateReadiness([obs(), obs()]);
    const mercoledi = new Date('2026-01-07T10:00:00+01:00');
    expect(shouldDeliver(pronta, mercoledi).deliver).toBe(true);
  });

  it('non consegna una giornata non pronta, nemmeno nella finestra', () => {
    const nonPronta = evaluateReadiness([obs({ matchesFinished: 8 })]);
    expect(shouldDeliver(nonPronta, new Date('2026-01-06T09:30:00+01:00')).deliver).toBe(false);
  });
});

describe('canary anti-redesign', () => {
  const golden = { data: { players: [{ id: 'p1', vote: 6.5, name: 'Tizio' }] }, meta: { page: 1 } };

  it('non segnala nulla quando la forma è identica', () => {
    const current = { data: { players: [{ id: 'p2', vote: 7, name: 'Caio' }] }, meta: { page: 2 } };
    const report = detectDrift(current, golden);
    expect(report.ok).toBe(true);
    expect(formatDriftReport(report)).toMatch(/Nessuna deriva/);
  });

  it('rileva un campo sparito come deriva bloccante', () => {
    const current = { data: { players: [{ id: 'p1', name: 'Tizio' }] }, meta: { page: 1 } };
    const report = detectDrift(current, golden);
    expect(report.ok).toBe(false);
    expect(report.breaking[0]?.path).toBe('$.data.players[].vote');
    expect(report.breaking[0]?.kind).toBe('campo-mancante');
  });

  it('rileva un tipo cambiato', () => {
    const current = { data: { players: [{ id: 'p1', vote: '6.5', name: 'Tizio' }] }, meta: { page: 1 } };
    expect(detectDrift(current, golden).breaking[0]?.kind).toBe('tipo-cambiato');
  });

  it('considera un campo nuovo informativo, non bloccante', () => {
    const current = { data: { players: [{ id: 'p1', vote: 6.5, name: 'Tizio', xg: 0.4 }] }, meta: { page: 1 } };
    const report = detectDrift(current, golden);
    expect(report.ok).toBe(true);
    expect(report.informational[0]?.path).toBe('$.data.players[].xg');
  });

  it('non scambia un campo opzionale nullo per una deriva', () => {
    const current = { data: { players: [{ id: 'p1', vote: null, name: 'Tizio' }] }, meta: { page: 1 } };
    expect(detectDrift(current, golden).ok).toBe(true);
  });

  it('descrive gli array campionando il primo elemento', () => {
    expect(describeShape([1, 2, 3])).toEqual({ t: 'array', of: { t: 'primitive', type: 'number' } });
    expect(describeShape([])).toEqual({ t: 'array', of: null });
  });
});

describe('relay dell’estensione', () => {
  it('risolve percorsi con punti e indici', () => {
    const src = { a: { b: [{ c: 42 }] } };
    expect(resolvePath(src, 'a.b[0].c')).toBe(42);
    expect(resolvePath(src, 'a.b.0.c')).toBe(42);
    expect(resolvePath(src, 'a.x.y')).toBeUndefined();
    expect(resolvePath(src, '$')).toBe(src);
  });

  it('applica una mappatura aggiornabile senza ripubblicare l’estensione', () => {
    const payload = { d: { rows: [{ pid: 'p1', s: { v: 6.5 } }, { pid: 'p2', s: { v: 7 } }] } };
    const records = applyMapping(payload, {
      version: 3, root: 'd.rows', fields: { playerId: 'pid', vote: 's.v' },
    });
    expect(records).toEqual([
      { playerId: 'p1', vote: 6.5 },
      { playerId: 'p2', vote: 7 },
    ]);
  });

  it('fallisce indicando la deriva se il percorso non porta a un elenco', () => {
    expect(() => applyMapping({ d: {} }, { version: 1, root: 'd.rows', fields: {} }))
      .toThrow(AdapterError);
    expect(() => applyMapping({ d: {} }, { version: 1, root: 'd.rows', fields: {} }))
      .toThrow(/deriva della piattaforma/);
  });

  it('rifiuta un envelope malformato: quel che arriva da un client è ostile', () => {
    expect(() => parseEnvelope({ clientVersion: '1.0' })).toThrow(/Envelope del relay non valido/);
    const ok = parseEnvelope({
      clientVersion: '1.2.0', platform: 'fantacalcio', leagueExternalId: 'abc',
      matchday: 12, capturedAt: '2026-01-06T08:00:00+01:00', payloads: { voti: {} },
    });
    expect(ok.matchday).toBe(12);
  });

  it('misura la copertura della mappatura: è il segnale del canary', () => {
    const records = [
      { playerId: 'p1', vote: 6 },
      { playerId: 'p2', vote: undefined },
      { playerId: 'p3', vote: 7 },
    ];
    const cov = mappingCoverage(records, ['playerId', 'vote']);
    expect(cov.ratio).toBeCloseTo(2 / 3, 5);
    expect(cov.missing.vote).toBe(1);
  });
});

describe('registro degli adapter', () => {
  it('espone gli adapter registrati e fallisce chiaramente sugli altri', () => {
    const registry = new AdapterRegistry();
    const fake = {
      platform: 'test',
      fetchSerieAMatchday: async () => { throw new Error('n/a'); },
      fetchLeagueWeek: async () => { throw new Error('n/a'); },
      observe: async () => { throw new Error('n/a'); },
    };
    registry.register(fake as never);
    expect(registry.list()).toEqual(['test']);
    expect(registry.get('test').platform).toBe('test');
    expect(() => registry.get('altro')).toThrow(/Nessun adapter registrato/);
  });
});

describe('due sorgenti, uno snapshot', () => {
  /**
   * LA PROPRIETA' CHE GIUSTIFICA L'ANTI-CORRUPTION LAYER.
   *
   * La stessa giornata, letta dall'estensione o esportata a mano in CSV, deve
   * produrre lo stesso identico snapshot. Se le due vie divergono, tutto cio'
   * che sta a valle — punteggi, fatti, giornale — dipende da quale sorgente e'
   * stata usata, e "abbiamo un percorso di riserva" diventa una frase senza
   * contenuto: il ripiego produrrebbe un prodotto diverso.
   */
  it('relay ed esportazione CSV producono lo stesso snapshot', () => {
    let w = generateWorld({ seed: 'convergenza', teams: 8, matchday: 5 });
    w = withOfficialScores(w, DEFAULT_RULESET);
    const quando = '2026-01-06T08:00:00+01:00';

    const csv = exportAll(w.serieA, w.snapshot);
    const daFile = importFromFiles({
      season: w.snapshot.season,
      matchday: w.snapshot.matchday,
      leagueId: w.snapshot.leagueId,
      leagueName: w.snapshot.leagueName,
      votiCsv: csv.votiCsv,
      formazioniCsv: csv.formazioniCsv,
      calendarioCsv: csv.calendarioCsv,
      roseCsv: csv.roseCsv,
      classificaCsv: csv.classificaCsv,
      collectedAt: quando,
    });

    const envelope = parseEnvelope({
      clientVersion: '1.0.0',
      platform: PROFILO_PROVA.platform,
      leagueExternalId: 'id-sulla-piattaforma',
      matchday: w.snapshot.matchday,
      capturedAt: quando,
      payloads: payloadPortaleDiProva(w.serieA, w.snapshot),
    });
    const daRelay = importFromRelay(envelope, PROFILO_PROVA, {
      leagueId: w.snapshot.leagueId,
      leagueName: w.snapshot.leagueName,
      season: w.snapshot.season,
    });

    // L'unica differenza legittima e' il collettore: dice da dove arriva il
    // dato, ed e' un'informazione che si vuole conservare.
    expect({ ...daRelay.snapshot, collector: 'file-import' }).toEqual(daFile.snapshot);
    expect(daRelay.serieA.players).toEqual(daFile.serieA.players);
  });

  it('la copertura cade quando la piattaforma sposta un campo', () => {
    const w = withOfficialScores(generateWorld({ seed: 'deriva', teams: 6, matchday: 3 }), DEFAULT_RULESET);
    const payloads = payloadPortaleDiProva(w.serieA, w.snapshot);

    // La piattaforma rinomina `voto` in `votoFinale`: e' la deriva tipica, e
    // non produce un errore — produce numeri mancanti. Va vista come calo di
    // copertura PRIMA di pubblicare, non come un giornale pieno di SV.
    const voti = payloads.voti as { data: { giocatori: { stats: Record<string, unknown> }[] } };
    for (const g of voti.data.giocatori) {
      g.stats.votoFinale = g.stats.voto;
      delete g.stats.voto;
    }

    const envelope = parseEnvelope({
      clientVersion: '1.0.0', platform: PROFILO_PROVA.platform,
      leagueExternalId: 'x', matchday: 3,
      capturedAt: '2026-01-06T08:00:00+01:00', payloads,
    });
    const { copertura } = recordsFromEnvelope(envelope, PROFILO_PROVA);
    const voto = copertura.find((c) => c.id === 'voti');
    expect(voto?.ratio).toBe(0);
    expect(voto?.campiMancanti.vote).toBe(voti.data.giocatori.length);
    expect(coperturaMinima(copertura)).toBe(0);
  });

  it('un payload obbligatorio mancante si ferma e lo dice', () => {
    const w = withOfficialScores(generateWorld({ seed: 'monco', teams: 6, matchday: 2 }), DEFAULT_RULESET);
    const payloads = payloadPortaleDiProva(w.serieA, w.snapshot);
    delete (payloads as Record<string, unknown>).formazioni;

    const envelope = parseEnvelope({
      clientVersion: '1.0.0', platform: PROFILO_PROVA.platform,
      leagueExternalId: 'x', matchday: 2,
      capturedAt: '2026-01-06T08:00:00+01:00', payloads,
    });
    expect(() => recordsFromEnvelope(envelope, PROFILO_PROVA)).toThrow(/formazioni/);
  });
});

describe('la giornata e’ finita? il segnale strutturale', () => {
  /**
   * Il controllo che serve al percorso dell'estensione, dove non c'e' un
   * osservatore a intervalli ma una persona che preme "Cattura" quando le pare.
   * Deve sbagliare in nessuna delle due direzioni, e la direzione peggiore e'
   * bocciare una giornata finita: l'utente non capisce perche' e smette di
   * fidarsi del controllo.
   */
  const mondo = (seed: string) =>
    withOfficialScores(generateWorld({ seed, teams: 8, matchday: 5 }), DEFAULT_RULESET);

  const osserva = (w: ReturnType<typeof mondo>) =>
    osservazioneDaGiornata(w.serieA.players, w.snapshot.lineups, {
      fetchedAt: '2026-01-06T08:00:00.000Z', contentHash: 'x',
    });

  it('una giornata completa passa, su ogni seed', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const o = osserva(mondo(seed));
      expect(o.squadreSenzaVoto).toEqual([]);
      expect(valuta([o], POLITICA_LETTURA_SINGOLA).ready).toBe(true);
    }
  });

  it('la quota di voti da sola NON basta a decidere', () => {
    /**
     * E' la misura che ha smontato la prima versione di questo controllo: su
     * giornate complete i titolari con voto stanno fra il 67% e l'81%, perche'
     * i senza voto esistono e sono legittimi. Una soglia al 90% su quel numero
     * boccerebbe giornate finite.
     */
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const o = osserva(mondo(seed));
      const quota = o.playersRated / o.playersExpected;
      expect(quota).toBeLessThan(0.9);
      expect(quota).toBeGreaterThan(0.5);
    }
  });

  it('una giornata a meta’ viene fermata, e dice quali squadre mancano', () => {
    const w = mondo('a');
    const squadre = [...new Set(w.serieA.players.map((p) => p.serieATeam))].sort();
    const nonGiocate = new Set(squadre.slice(0, Math.floor(squadre.length / 2)));

    const o = osservazioneDaGiornata(
      w.serieA.players.map((p) =>
        nonGiocate.has(p.serieATeam) ? { ...p, vote: null, minutes: 0 } : p),
      w.snapshot.lineups,
      { fetchedAt: '2026-01-06T08:00:00.000Z', contentHash: 'x' },
    );

    const d = valuta([o], POLITICA_LETTURA_SINGOLA);
    expect(d.ready).toBe(false);
    expect(d.reason).toMatch(/partite ancora da giocare/);
    expect(o.squadreSenzaVoto).toEqual([...nonGiocate].sort());
  });

  it('una sola squadra ferma la giornata: un rinvio non e’ una giornata finita', () => {
    const w = mondo('b');
    const una = [...new Set(w.serieA.players.map((p) => p.serieATeam))].sort()[0]!;
    const o = osservazioneDaGiornata(
      w.serieA.players.map((p) => (p.serieATeam === una ? { ...p, vote: null } : p)),
      w.snapshot.lineups,
      { fetchedAt: '2026-01-06T08:00:00.000Z', contentHash: 'x' },
    );
    expect(valuta([o], POLITICA_LETTURA_SINGOLA).ready).toBe(false);
    expect(o.squadreSenzaVoto).toEqual([una]);
  });
});
