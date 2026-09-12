/**
 * ISPETTORE DI UNA FONTE HTTP.
 *
 * Serve a scrivere un profilo senza indovinare. Si punta a un endpoint vero
 * con la propria chiave, e questo dice: dov'e' l'elenco dentro la risposta,
 * quali campi hanno gli elementi, e quale mappatura ne verrebbe fuori.
 *
 * Esiste perche' la parte che NON si puo' scrivere a tavolino di un profilo
 * sono i nomi dei campi. Inventarli produce codice che sembra pronto e
 * fallisce al primo dato vero — ed e' esattamente l'errore contro cui e'
 * costruito il resto del progetto.
 *
 *   pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts \
 *     --url "https://api.esempio.org/v4/competitions/SA/matches?matchday=1" \
 *     --header "X-Auth-Token: LA_TUA_CHIAVE"
 *
 * La chiave si passa a riga di comando o in `FANTACOMICS_FONTE_CHIAVE` e non
 * viene MAI stampata, nemmeno dentro l'URL in caso di errore.
 */

import { scaricaRobots, consentito, jsonDentroHtml, scegliBlocco } from '@fantacomics/ingest';

type Argomenti = {
  url: string;
  /** Una pagina gia' salvata, da ispezionare senza chiedere niente a nessuno. */
  file: string;
  headers: Record<string, string>;
  profondita: number;
};

/**
 * Anche l'ispettore fa una richiesta al sito di qualcun altro, quindi si
 * presenta come si presenta la fonte vera. Dimenticarlo qui significherebbe
 * che la prima volta che quel sito ci vede siamo anonimi.
 */
const AGENTE = process.env.FANTACOMICS_USER_AGENT
  ?? 'FantaComics/1.0 (+https://fantacomics.it/bot)';

function leggiArgomenti(argv: string[]): Argomenti {
  const headers: Record<string, string> = {
    accept: 'application/json, text/html;q=0.9',
    'user-agent': AGENTE,
  };
  let url = '';
  let profondita = 3;

  let file = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') url = argv[++i] ?? '';
    else if (a === '--file') file = argv[++i] ?? '';
    else if (a === '--header') {
      const grezzo = argv[++i] ?? '';
      const taglio = grezzo.indexOf(':');
      if (taglio > 0) headers[grezzo.slice(0, taglio).trim()] = grezzo.slice(taglio + 1).trim();
    } else if (a === '--profondita') profondita = Number(argv[++i] ?? 3);
  }

  const chiave = process.env.FANTACOMICS_FONTE_CHIAVE;
  if (chiave && !Object.keys(headers).some((h) => /auth|key|token/i.test(h))) {
    headers.authorization = `Bearer ${chiave}`;
  }
  return { url, file, headers, profondita };
}

/** Il tipo di un valore, in una parola, piu' un campione corto. */
function descrivi(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `elenco[${v.length}]`;
  if (typeof v === 'object') return `oggetto{${Object.keys(v as object).length}}`;
  if (typeof v === 'string') {
    const corto = v.length > 28 ? `${v.slice(0, 28)}…` : v;
    return `testo "${corto}"`;
  }
  return `${typeof v} ${String(v)}`;
}

/**
 * Cerca gli ELENCHI dentro la risposta.
 *
 * E' la domanda che conta per un profilo: `root` e' il percorso di un elenco,
 * e i campi si leggono dentro i suoi elementi. Un servizio che chiamasse
 * l'elenco `response`, `data.matches` o `events` va bene lo stesso — purche'
 * si sappia dove guardare, ed e' proprio cio' che si sta cercando.
 */
function elenchi(v: unknown, percorso = '', profondita = 3): { percorso: string; quanti: number; campione: unknown }[] {
  if (profondita < 0 || v === null || typeof v !== 'object') return [];
  if (Array.isArray(v)) {
    return [{ percorso: percorso || '$', quanti: v.length, campione: v[0] }];
  }
  const out: { percorso: string; quanti: number; campione: unknown }[] = [];
  for (const [k, sotto] of Object.entries(v as Record<string, unknown>)) {
    out.push(...elenchi(sotto, percorso ? `${percorso}.${k}` : k, profondita - 1));
  }
  return out;
}

/** I campi di un elemento, appiattiti in percorsi relativi. */
function campi(v: unknown, prefisso = '', profondita = 3): [string, unknown][] {
  if (profondita < 0 || v === null || typeof v !== 'object' || Array.isArray(v)) return [];
  const out: [string, unknown][] = [];
  for (const [k, sotto] of Object.entries(v as Record<string, unknown>)) {
    const p = prefisso ? `${prefisso}.${k}` : k;
    out.push([p, sotto]);
    if (sotto !== null && typeof sotto === 'object' && !Array.isArray(sotto)) {
      out.push(...campi(sotto, p, profondita - 1));
    }
  }
  return out;
}

/**
 * I campi canonici che il prodotto si aspetta, e gli indizi per riconoscerli.
 *
 * E' un SUGGERIMENTO, non una decisione: stampa cosa somiglia a cosa e lascia
 * scegliere a chi guarda. Un accoppiamento automatico su un nome somigliante
 * e' il modo piu' rapido di mappare il campo sbagliato senza accorgersene.
 */
const INDIZI: Record<string, RegExp> = {
  playerId: /^(id|player.?id|idgiocatore)$/i,
  playerName: /(player)?.?(name|nome)$/i,
  role: /(role|ruolo|position)$/i,
  serieATeam: /(team|squadra|club)(.?name)?$/i,
  vote: /(vote|voto|rating)$/i,
  minutes: /(minutes|minuti|played)$/i,
  goals: /(goals?|gol|reti)$/i,
  assists: /(assists?|assist)$/i,
  yellowCards: /(yellow|ammoniz)/i,
  redCards: /(red|espuls)/i,
  homeTeam: /(home)(.?team|.?name)?$/i,
  awayTeam: /(away)(.?team|.?name)?$/i,
  status: /(status|stato)$/i,
  matchday: /(matchday|giornata|round)$/i,
};

async function main(): Promise<void> {
  const { url, file, headers, profondita } = leggiArgomenti(process.argv.slice(2));

  /**
   * `--file`: ispeziona qualcosa che e' GIA' STATO SCARICATO da qualcun altro.
   *
   * Serve a chi non ha un terminale sulla macchina che quel sito lo raggiunge —
   * e serve anche qui dentro, dove il dominio e' bloccato. Accetta tre cose, e
   * le riconosce da sole: una risposta JSON, una pagina HTML salvata, o il file
   * prodotto da `strumenti/raccogli-fonte.js` nella console del browser.
   *
   * L'analisi e' sempre la stessa, con le stesse funzioni che poi usera' la
   * fonte vera: un'analisi scritta a parte direbbe «ho trovato» su qualcosa che
   * in produzione non si trova.
   */
  if (file) {
    const { readFile } = await import('node:fs/promises');
    let contenuto: string;
    try {
      contenuto = await readFile(file, 'utf8');
    } catch {
      console.error(`Non riesco a leggere "${file}".`);
      process.exit(1);
    }
    console.log(`Ispeziono il file ${file} (${contenuto.length} byte)\n`);

    let corpo: unknown;
    try {
      corpo = JSON.parse(contenuto);
    } catch {
      analizzaPagina(contenuto, profondita);
      return;
    }
    if (sembraRaccolta(corpo)) {
      analizzaRaccolta(corpo, profondita);
      return;
    }
    console.log('E\' JSON.\n');
    riassumi(corpo, profondita);
    return;
  }

  if (!url) {
    console.error('Serve --url oppure --file. Esempi:\n' +
      '  pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts --file pagina-salvata.html\n' +
      '  pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts \\\n' +
      '    --url "https://api.esempio.org/v4/competitions/SA/matches?matchday=1" \\\n' +
      '    --header "X-Auth-Token: LA_TUA_CHIAVE"');
    process.exit(1);
  }

  // L'host si stampa, la query no: puo' contenere la chiave.
  const soloHost = (() => { try { return new URL(url).origin + new URL(url).pathname; } catch { return '(url non valido)'; } })();
  console.log(`Interrogo ${soloHost}`);
  console.log(`Mi presento come: ${AGENTE}`);
  console.log(`Intestazioni: ${Object.keys(headers).join(', ')}`);

  /**
   * Si guarda il robots.txt PRIMA di chiedere, e lo si dice a schermo.
   *
   * Non blocca — questo e' uno strumento da riga di comando, usato da una
   * persona che sa cosa sta facendo — ma quella persona deve saperlo adesso,
   * non dopo aver costruito mezzo profilo.
   */
  try {
    const origine = new URL(url).origin;
    const robots = await scaricaRobots(origine, AGENTE);
    const percorso = new URL(url).pathname;
    console.log(
      consentito(robots, percorso)
        ? `robots.txt: consente ${percorso}`
        : `robots.txt: NON consente ${percorso} — quel sito ha chiesto di non farlo.`,
    );
    if (robots.attesaSecondi !== null) {
      console.log(`robots.txt: chiede ${robots.attesaSecondi}s fra una richiesta e l'altra.`);
    }
  } catch {
    console.log('robots.txt: non leggibile.');
  }
  console.log();

  let risposta: Response;
  try {
    risposta = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // Mai l'URL nel messaggio: se la chiave sta in query, finirebbe a schermo.
    console.error(`Non raggiungibile (${e instanceof Error ? e.name : 'errore'}).`);
    process.exit(1);
  }

  console.log(`Stato: ${risposta.status} ${risposta.statusText}`);
  const tipo = risposta.headers.get('content-type') ?? '(assente)';
  console.log(`Tipo: ${tipo}`);
  for (const h of ['x-requests-available-minute', 'x-ratelimit-requests-remaining', 'x-api-version']) {
    const v = risposta.headers.get(h);
    if (v) console.log(`${h}: ${v}`);
  }
  console.log();

  const testo = await risposta.text();
  let corpo: unknown;
  try {
    corpo = JSON.parse(testo);
  } catch {
    /**
     * NON E' UN VICOLO CIECO, ed e' il caso piu' probabile di tutti.
     *
     * Una pagina di un sito moderno e' HTML, ma i dati che mostra quasi sempre
     * viaggiano come JSON dentro quell'HTML — `__NEXT_DATA__`, un tag
     * `application/json`, o un `window.__QUALCOSA = {...}`. Prima qui lo
     * script si limitava a stampare i primi trecento caratteri e uscire, che
     * e' il momento in cui chi legge pensa «allora non si puo' fare» e invece
     * i dati erano li' sotto.
     */
    console.log('La risposta non e\' JSON: e\' una pagina. Cerco il JSON dentro l\'HTML.\n');
    if (!risposta.ok) {
      console.log(`(attenzione: il servizio ha risposto ${risposta.status}, quindi questa`);
      console.log('potrebbe essere una pagina di errore e non quella dei dati)\n');
    }
    analizzaPagina(testo, profondita);
    return;
  }

  if (!risposta.ok) {
    console.error('Il servizio ha rifiutato la richiesta. Corpo:\n');
    console.error(JSON.stringify(corpo, null, 2).slice(0, 600));
    process.exit(1);
  }

  riassumi(corpo, profondita);
}

/**
 * Una pagina HTML: elenca i blocchi JSON incorporati e ne ispeziona uno.
 *
 * Da' una PANORAMICA di tutti i blocchi e il dettaglio solo di quello che la
 * fonte prenderebbe davvero. Mostrarli tutti per esteso seppellirebbe la
 * risposta utile sotto il blob della pubblicita'; mostrarne uno solo
 * nasconderebbe il caso in cui l'euristica ha preso quello sbagliato, che e'
 * esattamente il momento in cui si ha bisogno di vedere gli altri.
 */
function analizzaPagina(html: string, profondita: number): void {
  const trovati = jsonDentroHtml(html);
  if (trovati.length === 0) {
    console.log('Nessun blocco JSON dentro la pagina.');
    console.log('Se i dati si vedono a schermo ma non sono qui dentro, la pagina li carica');
    console.log('DOPO, con una richiesta a parte. Due strade:');
    console.log('  - la scheda Rete del browser, filtro Fetch/XHR, e si guarda chi risponde;');
    console.log('  - strumenti/raccogli-fonte.js incollato nella console, che quelle');
    console.log('    richieste le registra da solo.');
    return;
  }

  console.log(`${trovati.length} blocchi JSON incorporati:\n`);
  for (const t of trovati) {
    const liste = elenchi(t.valore, '', profondita).sort((a, b) => b.quanti - a.quanti);
    const piuGrande = liste[0];
    console.log(`   ${t.dove.padEnd(34)} ${String(t.byte).padStart(9)} byte`
      + (piuGrande ? `   elenco piu' lungo: ${piuGrande.percorso} (${piuGrande.quanti})` : '   nessun elenco'));
  }

  const scelto = scegliBlocco(trovati);
  if (!scelto) return;
  console.log(`\nIspeziono: ${scelto.dove}`);
  console.log('Nel profilo: estrazione: "json-in-html"'
    + (scelto.id ? `, bloccoHtml: "${scelto.id}"` : '') + '\n');
  riassumi(scelto.valore, profondita);
}

/** Il file prodotto da `strumenti/raccogli-fonte.js`. */
type Raccolta = {
  fantacomics: string;
  quando?: unknown;
  indirizzo?: unknown;
  titolo?: unknown;
  pagina?: unknown;
  rete?: unknown;
};

function sembraRaccolta(v: unknown): v is Raccolta {
  return v !== null && typeof v === 'object'
    && typeof (v as { fantacomics?: unknown }).fantacomics === 'string';
}

/**
 * Il raccolto di una sessione di browser.
 *
 * Contiene due cose che nessun `curl` puo' dare: la pagina DOPO che il suo
 * JavaScript ha girato, e le risposte alle richieste che la pagina fa da sola.
 * Sui siti moderni i dati stanno quasi sempre nella seconda, quindi si guarda
 * prima la rete e solo dopo il documento.
 */
function analizzaRaccolta(r: Raccolta, profondita: number): void {
  console.log(`Raccolta da browser (${r.fantacomics})`);
  if (typeof r.indirizzo === 'string') console.log(`Pagina: ${r.indirizzo}`);
  if (typeof r.titolo === 'string') console.log(`Titolo: ${r.titolo}`);
  if (typeof r.quando === 'string') console.log(`Quando: ${r.quando}`);

  const rete = Array.isArray(r.rete) ? (r.rete as Record<string, unknown>[]) : [];
  const conCorpo: { url: string; corpo: unknown; quanti: number }[] = [];

  console.log(`\n══ RETE — ${rete.length} indirizzi interrogati dalla pagina\n`);
  for (const voce of rete) {
    const url = typeof voce.url === 'string' ? voce.url : '(senza indirizzo)';
    const corpo = typeof voce.corpo === 'string' ? voce.corpo : null;
    let quanti = -1;
    let letto: unknown;
    if (corpo) {
      try {
        letto = JSON.parse(corpo);
        const liste = elenchi(letto, '', profondita).sort((a, b) => b.quanti - a.quanti);
        quanti = liste[0]?.quanti ?? 0;
      } catch {
        quanti = -1;
      }
    }
    const nota = corpo === null
      ? 'solo indirizzo, contenuto non catturato'
      : quanti < 0 ? 'contenuto non JSON'
      : `JSON, elenco piu\' lungo ${quanti}`;
    console.log(`   ${nota.padEnd(38)} ${url}`);
    if (letto !== undefined && quanti > 0) conCorpo.push({ url, corpo: letto, quanti });
  }

  /**
   * Le candidate si ispezionano dalla piu' popolosa: un endpoint che
   * restituisce quattrocento righe e' la lista dei voti molto piu'
   * probabilmente di uno che ne restituisce tre. Ci si ferma a tre perche'
   * oltre e' rumore, ma l'elenco qui sopra le nomina tutte.
   */
  conCorpo.sort((a, b) => b.quanti - a.quanti);
  for (const c of conCorpo.slice(0, 3)) {
    console.log(`\n══ RISPOSTA DI ${c.url}\n`);
    riassumi(c.corpo, profondita);
  }
  if (conCorpo.length === 0) {
    console.log('\n   Nessuna risposta con contenuto: quelle richieste erano gia\' partite');
    console.log('   prima che il raccoglitore fosse attivo. Sulla pagina basta cambiare');
    console.log('   giornata e rieseguire  fantacomicsEsporta()');
  }

  if (typeof r.pagina === 'string' && r.pagina.length > 0) {
    console.log(`\n══ DOCUMENTO — ${r.pagina.length} byte di HTML\n`);
    analizzaPagina(r.pagina, profondita);
  }
}

/**
 * Il riassunto di un corpo gia' letto.
 *
 * Sta in una funzione perche' i percorsi che ci arrivano sono due — una
 * richiesta HTTP e un file salvato — e devono produrre lo STESSO esito. Due
 * copie divergerebbero il giorno in cui una delle due impara qualcosa, e chi
 * ha solo il browser riceverebbe un'analisi diversa da chi ha il terminale.
 */
function riassumi(corpo: unknown, profondita: number): void {
  console.log('── Chiavi di primo livello');
  if (corpo !== null && typeof corpo === 'object' && !Array.isArray(corpo)) {
    for (const [k, v] of Object.entries(corpo)) console.log(`   ${k}: ${descrivi(v)}`);
  } else {
    console.log(`   ${descrivi(corpo)}`);
  }

  const trovati = elenchi(corpo, '', profondita).sort((a, b) => b.quanti - a.quanti);
  console.log('\n── Elenchi trovati (candidati per `root`)');
  if (trovati.length === 0) console.log('   nessuno: questa risposta non contiene collezioni.');
  for (const t of trovati.slice(0, 6)) console.log(`   ${t.percorso}  →  ${t.quanti} elementi`);

  const principale = trovati[0];
  if (!principale || principale.campione === undefined) {
    console.log('\nNessun elemento da ispezionare.');
    return;
  }

  console.log(`\n── Campi di un elemento di "${principale.percorso}"`);
  const elencoCampi = campi(principale.campione, '', profondita);
  for (const [p, v] of elencoCampi) console.log(`   ${p.padEnd(34)} ${descrivi(v)}`);

  console.log('\n── Possibili corrispondenze coi campi canonici');
  console.log('   (suggerimenti da CONTROLLARE, non una mappatura pronta)');
  let almenoUno = false;
  for (const [canonico, indizio] of Object.entries(INDIZI)) {
    const candidati = elencoCampi
      .filter(([p]) => indizio.test(p.split('.').pop() ?? ''))
      .map(([p]) => p);
    if (candidati.length > 0) {
      almenoUno = true;
      console.log(`   ${canonico.padEnd(14)} ← ${candidati.join('  |  ')}`);
    }
  }
  if (!almenoUno) console.log('   nessuna: i nomi non somigliano a niente di noto, vanno letti a mano.');

  console.log(`\n── Bozza di mappatura da correggere a mano\n`);
  console.log(JSON.stringify({ version: 1, root: principale.percorso, fields: Object.fromEntries(
    Object.entries(INDIZI)
      .map(([canonico, indizio]) => [
        canonico,
        elencoCampi.find(([p]) => indizio.test(p.split('.').pop() ?? ''))?.[0],
      ])
      .filter((x): x is [string, string] => typeof x[1] === 'string'),
  ) }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
