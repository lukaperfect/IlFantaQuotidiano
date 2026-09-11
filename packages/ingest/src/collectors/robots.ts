/**
 * ROBOTS.TXT.
 *
 * Non e' un dispositivo di sicurezza e in quasi nessuna giurisdizione e'
 * vincolante di per se'. E' pero' il segnale piu' chiaro e piu' documentabile
 * di cosa il proprietario di un sito voglia, ed e' il primo fatto che viene
 * citato quando una raccolta automatica finisce in discussione. Leggerlo costa
 * una richiesta al giorno; ignorarlo senza saperlo e' l'unico modo di
 * sbagliare senza averlo scelto.
 *
 * Qui si implementa il comportamento descritto dalla RFC 9309, con due
 * semplificazioni dichiarate: niente `Sitemap` (non ci serve) e niente
 * caratteri jolly oltre `*` e `$` (li usano quasi tutti cosi').
 *
 * `Crawl-delay` non sta nella RFC ma lo scrivono in molti, ed e' esattamente
 * la richiesta «rallenta»: si legge e si rispetta, perche' e' gratis ed e'
 * l'unica cosa che un sito puo' chiederci senza un contratto.
 */

export type Robots = {
  /** Le regole che valgono per NOI, gia' selezionate dal gruppo giusto. */
  regole: readonly { consenti: boolean; percorso: string }[];
  /** Secondi da aspettare fra una richiesta e l'altra, se dichiarati. */
  attesaSecondi: number | null;
};

/** Un robots.txt assente o illeggibile non vieta niente: e' il default del web. */
export const ROBOTS_PERMISSIVO: Robots = { regole: [], attesaSecondi: null };

/**
 * Analizza un robots.txt e tiene SOLO il gruppo che ci riguarda.
 *
 * La regola della RFC e' che vale il gruppo con lo User-agent piu' specifico
 * che corrisponde; se nessuno corrisponde vale `*`. Non si sommano: prendere
 * l'unione dei gruppi renderebbe piu' permissivo un sito che ha scritto una
 * regola stretta apposta per noi.
 */
export function analizzaRobots(testo: string, nostroAgente: string): Robots {
  const agente = nostroAgente.toLowerCase();

  type Gruppo = { agenti: string[]; regole: { consenti: boolean; percorso: string }[]; attesa: number | null };
  const gruppi: Gruppo[] = [];
  let corrente: Gruppo | null = null;
  // Righe `User-agent` consecutive formano UN gruppo solo: il primo direttivo
  // che non e' un agente chiude l'elenco e comincia il corpo.
  let appenaVistoAgente = false;

  for (const riga of testo.split(/\r?\n/)) {
    const senzaCommento = riga.split('#')[0] ?? '';
    const taglio = senzaCommento.indexOf(':');
    if (taglio < 0) continue;
    const campo = senzaCommento.slice(0, taglio).trim().toLowerCase();
    const valore = senzaCommento.slice(taglio + 1).trim();
    if (campo === '') continue;

    if (campo === 'user-agent') {
      if (!appenaVistoAgente || corrente === null) {
        corrente = { agenti: [], regole: [], attesa: null };
        gruppi.push(corrente);
      }
      corrente.agenti.push(valore.toLowerCase());
      appenaVistoAgente = true;
      continue;
    }

    appenaVistoAgente = false;
    if (corrente === null) continue;

    if (campo === 'disallow') corrente.regole.push({ consenti: false, percorso: valore });
    else if (campo === 'allow') corrente.regole.push({ consenti: true, percorso: valore });
    else if (campo === 'crawl-delay') {
      const n = Number(valore.replace(',', '.'));
      if (Number.isFinite(n) && n >= 0) corrente.attesa = n;
    }
  }

  // Il gruppo con il nome piu' lungo che corrisponde vince; `*` e' il ripiego.
  let scelto: Gruppo | null = null;
  let lunghezzaScelta = -1;
  for (const g of gruppi) {
    for (const a of g.agenti) {
      if (a === '*') {
        if (scelto === null) { scelto = g; lunghezzaScelta = 0; }
        continue;
      }
      // Corrispondenza per prefisso, come fanno i crawler veri: un gruppo per
      // «fantacomics» vale anche per «fantacomics/1.0 (+https://...)».
      if (agente.startsWith(a) && a.length > lunghezzaScelta) {
        scelto = g;
        lunghezzaScelta = a.length;
      }
    }
  }

  if (!scelto) return ROBOTS_PERMISSIVO;
  return { regole: scelto.regole, attesaSecondi: scelto.attesa };
}

/** Il modello di percorso corrisponde a questo percorso? Gestisce `*` e `$`. */
function corrisponde(modello: string, percorso: string): boolean {
  // Una `Disallow:` vuota non vieta niente: e' il modo di dire «tutto permesso».
  if (modello === '') return false;
  const esatto = modello.endsWith('$');
  const corpo = esatto ? modello.slice(0, -1) : modello;

  const pezzi = corpo.split('*');
  let posizione = 0;
  for (let i = 0; i < pezzi.length; i++) {
    const pezzo = pezzi[i] as string;
    if (pezzo === '') continue;
    const trovato = i === 0 ? (percorso.startsWith(pezzo) ? 0 : -1) : percorso.indexOf(pezzo, posizione);
    if (trovato < 0) return false;
    posizione = trovato + pezzo.length;
  }
  // Con `$` il modello deve finire dove finisce il percorso.
  if (esatto) {
    const ultimo = pezzi[pezzi.length - 1] as string;
    return percorso.endsWith(ultimo) && posizione === percorso.length;
  }
  return true;
}

/**
 * Possiamo chiedere questo percorso?
 *
 * A parita' di corrispondenza vince la regola PIU' LUNGA, e in caso di pari
 * lunghezza vince `Allow`: e' quanto prescrive la RFC, e ha senso — una regola
 * piu' specifica e' stata scritta apposta.
 */
export function consentito(robots: Robots, percorso: string): boolean {
  let miglioreLunghezza = -1;
  let migliore: boolean | null = null;

  for (const r of robots.regole) {
    if (!corrisponde(r.percorso, percorso)) continue;
    const lunghezza = r.percorso.length;
    if (lunghezza > miglioreLunghezza || (lunghezza === miglioreLunghezza && r.consenti)) {
      miglioreLunghezza = lunghezza;
      migliore = r.consenti;
    }
  }
  // Nessuna regola corrisponde: permesso. E' il default del web, non una
  // scelta nostra.
  return migliore ?? true;
}

/**
 * Scarica e analizza il robots.txt di un'origine.
 *
 * Ogni guasto — rete, 404, 500, timeout — si risolve in PERMISSIVO, e non e'
 * indulgenza: un robots.txt assente significa davvero «nessuna restrizione», e
 * trattare un errore di rete come un divieto spegnerebbe il prodotto ogni volta
 * che il sito ha un raffreddore. L'unica lettura prudente al contrario sarebbe
 * bloccare tutto, e bloccherebbe anche i siti che non hanno mai detto niente.
 */
export async function scaricaRobots(
  origine: string,
  nostroAgente: string,
  opzioni: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Robots> {
  const chiamata = opzioni.fetchImpl ?? fetch;
  try {
    const risposta = await chiamata(new URL('/robots.txt', origine), {
      headers: { 'user-agent': nostroAgente, accept: 'text/plain' },
      signal: AbortSignal.timeout(opzioni.timeoutMs ?? 10000),
    });
    if (!risposta.ok) return ROBOTS_PERMISSIVO;
    const testo = await risposta.text();
    // Un robots.txt enorme e' quasi sempre una pagina di errore travestita.
    if (testo.length > 512 * 1024) return ROBOTS_PERMISSIVO;
    return analizzaRobots(testo, nostroAgente);
  } catch {
    return ROBOTS_PERMISSIVO;
  }
}
