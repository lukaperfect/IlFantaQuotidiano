/**
 * VERIFICA DEL PRIMO NUMERO DI UNA LEGA NUOVA.
 *
 * E' il caso commerciale che governa il progetto: un admin paga, carica il file
 * delle rose, e il giornale deve uscire. In quel momento non esiste uno
 * storico, non esiste una classifica, non esiste un risultato — esiste un'asta.
 * Questa verifica parte dal file xlsx VERO scaricato dalla piattaforma e
 * controlla che ne esca un giornale intero.
 *
 * Controlla anche cio' che l'anteprima NON deve fare, che e' la parte in cui si
 * sbaglia in silenzio: scrivere nello storico, sporcare il corpus della
 * rarita', far avanzare il puntatore delle giornate, o far credere coperti
 * tutti i presidenti.
 *
 *   pnpm exec tsx apps/worker/src/scripts/verifica-anteprima.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_RULESET, type LeagueRoster } from '@fantacomics/core';
import { importaRoseXlsx } from '@fantacomics/ingest';
import { InMemoryLeagueStore, runAnteprimaPipeline } from '@fantacomics/pipeline';
import { TemplateDriver } from '@fantacomics/llm';
import { mazzoPer } from '@fantacomics/editorial';

const problemi: string[] = [];
function ok(nome: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FALLITO'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) problemi.push(nome);
}

const qui = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  qui, '../../../../packages/ingest/src/__fixtures__/rose-leghe-fantacalcio.xlsx',
);

function roseVere(): LeagueRoster {
  const esito = importaRoseXlsx(readFileSync(FIXTURE));
  return {
    season: '2025-26',
    importedAt: new Date().toISOString(),
    source: 'xlsx-rose',
    teams: esito.squadre.map((s) => ({
      teamId: s.teamId, teamName: s.teamName, players: s.giocatori,
    })),
  };
}

async function main(): Promise<void> {
  const roster = roseVere();
  console.log(
    `Rose lette dal file vero: ${roster.teams.length} squadre, `
    + `${roster.teams.reduce((n, t) => n + t.players.length, 0)} giocatori\n`,
  );

  const store = new InMemoryLeagueStore();
  const leagueId = 'lega-anteprima';
  await store.saveConfig({
    leagueId,
    ownerId: 'acc-verifica',
    publicSlug: 'slug-di-verifica-lungo',
    relaySecret: null,
    leagueName: 'Lega dell Anteprima',
    ruleset: DEFAULT_RULESET,
    spice: 2,
    createdAt: new Date().toISOString(),
    lastMatchday: null,
  });

  /**
   * IL CASO PIU' POVERO POSSIBILE: nessun calendario.
   *
   * Alla prima giornata di una lega appena iscritta il calendario puo' non
   * essere ancora arrivato dalla fonte automatica. Il giornale deve uscire
   * comunque, perche' l'alternativa e' un cliente che ha appena pagato e non
   * vede niente.
   */
  const senzaCalendario = await runAnteprimaPipeline({
    leagueId, leagueName: 'Lega dell Anteprima', roster, matchday: 1, fixtures: [],
    store, rulesetVersion: DEFAULT_RULESET.version,
    driver: new TemplateDriver(), fallback: new TemplateDriver(),
  });

  ok('giornata 1 senza calendario: il giornale esce',
    senzaCalendario.edition.articles.length >= 6,
    `${senzaCalendario.edition.articles.length} pezzi`);
  ok('e nomina tutte le squadre della lega',
    nominate(senzaCalendario.facts.facts).size === roster.teams.length,
    `${nominate(senzaCalendario.facts.facts).size}/${roster.teams.length}`);
  ok('la testata dice che e\' una vigilia',
    senzaCalendario.edition.masthead.tagline.includes('Vigilia'),
    senzaCalendario.edition.masthead.tagline);
  ok('nessuna classifica inventata a zero partite giocate',
    senzaCalendario.pack.standings.length === 0,
    `${senzaCalendario.pack.standings.length} righe`);
  ok('nessun tabellino: non si e\' giocato',
    senzaCalendario.pack.results.length === 0);
  ok('confidenza sopra la soglia di pubblicazione',
    senzaCalendario.publishable, String(senzaCalendario.confidence));

  /**
   * LA PAGINA, NON SOLO I DATI.
   *
   * Queste asserzioni esistono perche' tre difetti veri sono passati sotto le
   * altre: il titolo del documento diceva «Giornata 1» mentre la testata diceva
   * «Vigilia della giornata 1»; comparivano le intestazioni «Risultati» e
   * «Classifica» con il vuoto sotto; e c'erano le card personali, che una
   * vigilia non ha. Nessuna asserzione se ne era accorta — li ho visti solo
   * leggendo la pagina.
   */
  const html = senzaCalendario.html.web;
  const titolo = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? '';
  ok('il titolo del documento dice che e\' una vigilia',
    titolo.includes('Vigilia della giornata 1'), titolo);
  ok('nessuna intestazione «Risultati» su un numero senza risultati',
    !html.includes('Risultati'));
  ok('nessuna intestazione «Classifica» a zero partite giocate',
    !html.includes('Classifica'));
  ok('nessuna card personale: non c\'e\' ancora una giornata da raccontare',
    !html.includes('Una card per ogni presidente')
    && senzaCalendario.edition.personalCards.length === 0,
    `${senzaCalendario.edition.personalCards.length} card`);

  /**
   * OGNI FORMAT USATO DEVE DICHIARARSI ADATTO ALLA VIGILIA.
   *
   * E' il controllo che coglie il difetto piu' imbarazzante possibile: un
   * necrologio, un'epigrafe per i punti lasciati in panchina o un tabellino
   * commentato in un numero che esce prima che si giochi.
   */
  const ammessi = new Set(mazzoPer('anteprima').map((f) => f.id));
  const intrusi = senzaCalendario.edition.articles
    .map((a) => a.format)
    .filter((id) => !ammessi.has(id));
  ok('nessun format retrospettivo in un numero di vigilia',
    intrusi.length === 0, intrusi.length ? intrusi.join(', ') : '0 intrusi');

  // --- Cio' che l'anteprima NON deve toccare.
  ok('lo storico resta vuoto', (await store.getHistory(leagueId)).entries.length === 0);
  ok('il corpus della rarita\' resta intatto', (await store.getCorpus()) === null);
  ok('il puntatore delle giornate non avanza',
    (await store.getConfigForOwner(leagueId, 'acc-verifica'))?.lastMatchday === null,
    `lastMatchday=${(await store.getConfigForOwner(leagueId, 'acc-verifica'))?.lastMatchday}`);

  const memoria = await store.getMemory(leagueId);
  ok('la vigilia non fa credere coperti i presidenti',
    Object.keys(memoria.lastAppearance).length === 0,
    `${Object.keys(memoria.lastAppearance).length} comparse registrate`);
  ok('ma i format usati entrano in memoria: il retrospettivo non li ripete',
    Object.keys(memoria.lastFormatUse).length >= 6,
    `${Object.keys(memoria.lastFormatUse).length} format`);

  /**
   * LA COPPIA DELLA SETTIMANA: vigilia e retrospettivo della STESSA giornata
   * devono coesistere. Con la sola giornata come chiave la seconda
   * sovrascriveva la prima, e il cliente perdeva un numero su due.
   */
  const ids = roster.teams.map((t) => t.teamId);
  const fixtures: { homeTeamId: string; awayTeamId: string }[] = [];
  for (let i = 0; i + 1 < ids.length; i += 2) {
    fixtures.push({ homeTeamId: ids[i] as string, awayTeamId: ids[i + 1] as string });
  }

  const conCalendario = await runAnteprimaPipeline({
    leagueId, leagueName: 'Lega dell Anteprima', roster, matchday: 2, fixtures,
    store, rulesetVersion: DEFAULT_RULESET.version,
    driver: new TemplateDriver(), fallback: new TemplateDriver(),
  });
  ok('col calendario escono anche le sfide in programma',
    conCalendario.pack.fixtures.length === fixtures.length,
    `${conCalendario.pack.fixtures.length} sfide`);
  ok('col calendario la pagina stampa le partite in programma',
    conCalendario.html.web.includes('Si gioca')
    && !conCalendario.html.web.includes('Risultati'));
  ok('le sfide portano NOMI di squadra, non id',
    conCalendario.pack.fixtures.every((f) => !f.homeTeam.startsWith('squadra-')),
    conCalendario.pack.fixtures[0]
      ? `${conCalendario.pack.fixtures[0].homeTeam} — ${conCalendario.pack.fixtures[0].awayTeam}`
      : 'nessuna');

  const elenco = await store.listEditions(leagueId);
  ok('le due vigilie sono due edizioni distinte', elenco.length === 2, JSON.stringify(elenco));
  ok('la vigilia della 1 si rilegge dopo aver scritto la 2',
    (await store.getEdition(leagueId, 1, 'anteprima')) !== null);
  ok('e non e\' finita sull\'indirizzo del retrospettivo',
    (await store.getEdition(leagueId, 1, 'giornale')) === null);

  console.log(`\n${problemi.length === 0 ? 'Tutto verde.' : `FALLITE: ${problemi.join(', ')}`}`);
  if (problemi.length > 0) process.exit(1);
}

function nominate(facts: readonly { subjects: readonly { kind: string; id: string }[] }[]): Set<string> {
  return new Set(facts.flatMap((f) => f.subjects.filter((s) => s.kind === 'team').map((s) => s.id)));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
