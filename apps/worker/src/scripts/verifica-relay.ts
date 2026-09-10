/**
 * Verifica del relay end-to-end, sopra HTTP vero.
 *
 * Crea una lega con la sua chiave, costruisce i payload del portale di prova a
 * partire da un mondo sintetico, e li manda all'endpoint esattamente come fara'
 * l'estensione. Poi controlla che il giornale esista davvero all'indirizzo
 * pubblico — perche' "202 accettato" non significa che sia uscito qualcosa.
 *
 * Copre anche i casi che contano piu' di quello felice: senza chiave, con
 * chiave sbagliata, con una chiave revocata, e con una piattaforma che ha
 * spostato un campo.
 */
import pg from 'pg';
import {
  PostgresLeagueStore, FileLeagueStore, type LeagueStore,
} from '@fantacomics/pipeline';
import { DEFAULT_RULESET, stableHash } from '@fantacomics/core';
import {
  generateWorld, withOfficialScores, payloadPortaleDiProva, PROFILO_PROVA,
} from '@fantacomics/ingest';
import { randomToken } from '@fantacomics/auth';

const base = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
const url = process.env.DATABASE_URL;

const pool = url ? new pg.Pool({ connectionString: url }) : null;
const store: LeagueStore = pool
  ? new PostgresLeagueStore(pool)
  : new FileLeagueStore(process.env.FANTACOMICS_DATA ?? '.data');

const problemi: string[] = [];
function ok(nome: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
}

async function posta(chiave: string | null, corpo: unknown): Promise<Response> {
  return fetch(`${base}/api/relay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(chiave ? { authorization: `Bearer ${chiave}` } : {}),
    },
    body: JSON.stringify(corpo),
  });
}

async function main(): Promise<void> {
  const leagueId = `relay-${stableHash(String(Date.now()))}`;
  const publicSlug = randomToken(18);
  const chiave = randomToken(24);

  await store.saveConfig({
    leagueId,
    ownerId: 'acc-verifica',
    publicSlug,
    relaySecret: chiave,
    leagueName: 'Lega del Relay',
    ruleset: DEFAULT_RULESET,
    spice: 2,
    createdAt: new Date().toISOString(),
    lastMatchday: null,
  });

  const mondo = withOfficialScores(
    generateWorld({ seed: 'relay-verifica', teams: 8, matchday: 7 }),
    DEFAULT_RULESET,
  );
  const envelope = {
    clientVersion: '1.0.0',
    platform: PROFILO_PROVA.platform,
    leagueExternalId: 'id-sulla-piattaforma',
    matchday: 7,
    season: mondo.snapshot.season,
    capturedAt: new Date().toISOString(),
    payloads: payloadPortaleDiProva(mondo.serieA, mondo.snapshot),
  };

  // 1. Senza chiave e con chiave inventata: identici, e non passano.
  const senza = await posta(null, envelope);
  ok('senza chiave risponde 401', senza.status === 401, `status ${senza.status}`);
  const finta = await posta('chiave-inventata-da-un-estraneo', envelope);
  ok('chiave sconosciuta risponde 401', finta.status === 401, `status ${finta.status}`);
  ok('le due risposte sono indistinguibili',
     JSON.stringify(await senza.json()) === JSON.stringify(await finta.json()));

  // 2. La configurazione arriva dal server, non e' cablata nell'estensione.
  const conf = await fetch(`${base}/api/relay?platform=portale-di-prova`, {
    headers: { authorization: `Bearer ${chiave}` },
  });
  const profilo = await conf.json() as { capture?: { id: string }[]; version?: number };
  ok('il profilo arriva dal server',
     conf.status === 200 && (profilo.capture?.length ?? 0) === 5,
     `v${profilo.version}, ${profilo.capture?.length} regole`);

  // 3. Il giro buono.
  const buona = await posta(chiave, envelope);
  const esito = await buona.json() as Record<string, unknown>;
  ok('envelope accettato', buona.status === 200, `status ${buona.status} ${JSON.stringify(esito).slice(0, 160)}`);
  ok('copertura piena', esito.copertura === 1, String(esito.copertura));
  ok('otto squadre lette', esito.squadre === 8, String(esito.squadre));

  // 4. Il giornale esiste DAVVERO all'indirizzo pubblico.
  const giornale = await fetch(`${base}/g/${publicSlug}/7`);
  const html = await giornale.text();
  ok('il giornale e’ pubblicato', giornale.status === 200, `status ${giornale.status}`);
  ok('contiene pezzi veri', (html.match(/<article class="art[ "]/g) ?? []).length >= 6,
     `${(html.match(/<article class="art[ "]/g) ?? []).length} pezzi`);
  ok('l’identita’ della lega viene dalla chiave, non dal corpo',
     html.includes('Lega del Relay'));

  // 5. La piattaforma sposta un campo: si deve fermare, non pubblicare SV.
  const storto = structuredClone(envelope) as typeof envelope;
  const voti = storto.payloads.voti as { data: { giocatori: { stats: Record<string, unknown> }[] } };
  for (const g of voti.data.giocatori) { g.stats.votoFinale = g.stats.voto; delete g.stats.voto; }
  const deriva = await posta(chiave, storto);
  const derivaEsito = await deriva.json() as { stato?: string };
  ok('una deriva della piattaforma blocca invece di pubblicare',
     deriva.status === 422 && derivaEsito.stato === 'deriva-sospetta',
     `status ${deriva.status}`);

  // 5-bis. Una giornata a meta' non si pubblica.
  //
  // Qui non c'e' un osservatore a intervalli: c'e' una persona che preme
  // "Cattura" quando le pare. Se preme di domenica sera meta' Serie A non ha
  // giocato, e la riconciliazione non se ne accorge — i punteggi ufficiali
  // parziali tornano benissimo con quelli parziali ricalcolati.
  const aMeta = structuredClone(envelope) as typeof envelope;
  const votiMeta = aMeta.payloads.voti as {
    data: { giocatori: { squadra: string; stats: Record<string, unknown> }[] };
  };
  const squadre = [...new Set(votiMeta.data.giocatori.map((g) => g.squadra))].sort();
  const nonGiocate = new Set(squadre.slice(0, Math.floor(squadre.length / 2)));
  for (const g of votiMeta.data.giocatori) {
    if (nonGiocate.has(g.squadra)) { g.stats.voto = null; g.stats.minuti = 0; }
  }
  aMeta.matchday = 9;
  const meta = await posta(chiave, aMeta);
  const metaEsito = await meta.json() as { stato?: string; squadreSenzaVoto?: string[] };
  ok('una giornata a meta’ viene rifiutata invece che pubblicata',
     meta.status === 409 && metaEsito.stato === 'giornata-non-pronta',
     `status ${meta.status}`);
  ok('e dice quali squadre non hanno ancora un voto',
     (metaEsito.squadreSenzaVoto?.length ?? 0) === nonGiocate.size,
     `${metaEsito.squadreSenzaVoto?.length} squadre`);
  const nonPubblicata = await fetch(`${base}/g/${publicSlug}/9`);
  ok('e infatti quella giornata non esiste', nonPubblicata.status === 404,
     `status ${nonPubblicata.status}`);

  // 6. Revocare la chiave la spegne subito.
  const config = await store.getConfigForOwner(leagueId, 'acc-verifica');
  await store.saveConfig({ ...config!, relaySecret: null });
  const dopoRevoca = await posta(chiave, envelope);
  ok('la chiave revocata non funziona piu’', dopoRevoca.status === 401, `status ${dopoRevoca.status}`);

  console.log(problemi.length === 0 ? '\nTUTTO OK' : `\nPROBLEMI: ${problemi.join(', ')}`);
  await pool?.end();
  process.exit(problemi.length === 0 ? 0 : 1);
}

await main();
