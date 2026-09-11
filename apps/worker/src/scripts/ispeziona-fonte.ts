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

type Argomenti = { url: string; headers: Record<string, string>; profondita: number };

function leggiArgomenti(argv: string[]): Argomenti {
  const headers: Record<string, string> = { accept: 'application/json' };
  let url = '';
  let profondita = 3;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') url = argv[++i] ?? '';
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
  return { url, headers, profondita };
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
  const { url, headers, profondita } = leggiArgomenti(process.argv.slice(2));
  if (!url) {
    console.error('Serve --url. Esempio:\n' +
      '  pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts \\\n' +
      '    --url "https://api.esempio.org/v4/competitions/SA/matches?matchday=1" \\\n' +
      '    --header "X-Auth-Token: LA_TUA_CHIAVE"');
    process.exit(1);
  }

  // L'host si stampa, la query no: puo' contenere la chiave.
  const soloHost = (() => { try { return new URL(url).origin + new URL(url).pathname; } catch { return '(url non valido)'; } })();
  console.log(`Interrogo ${soloHost}`);
  console.log(`Intestazioni: ${Object.keys(headers).join(', ')}\n`);

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
    console.error('La risposta non e\' JSON. Primi 300 caratteri:\n');
    console.error(testo.slice(0, 300));
    process.exit(1);
  }

  if (!risposta.ok) {
    console.error('Il servizio ha rifiutato la richiesta. Corpo:\n');
    console.error(JSON.stringify(corpo, null, 2).slice(0, 600));
    process.exit(1);
  }

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
