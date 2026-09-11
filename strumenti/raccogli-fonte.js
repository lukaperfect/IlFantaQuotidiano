/**
 * RACCOGLITORE DA BROWSER.
 *
 * Si incolla nella console degli strumenti per sviluppatori, sulla pagina che
 * pubblica i voti, e produce un file da riportare indietro. Serve a chi non ha
 * un terminale sulla macchina che quel sito lo raggiunge: senza questo, per
 * scrivere il profilo di una fonte servirebbe una riga di comando.
 *
 * QUESTO SCRIPT NON ANALIZZA NIENTE, e non e' una limitazione: e' la ragione
 * per cui esiste in questa forma. L'analisi la fa `ispeziona-fonte.ts`, una
 * sola volta, con le stesse funzioni che poi usera' la fonte vera. Se anche
 * qui dentro ci fosse un'euristica che sceglie «il blocco buono», il giorno in
 * cui le due divergono questo direbbe «trovato» su qualcosa che la fonte non
 * trova mai. Quindi qui si RACCOGLIE e basta: la pagina cosi' com'e' adesso,
 * e le richieste che la pagina fa.
 *
 * Cosa raccoglie:
 *   1. il DOM ATTUALE, cioe' la pagina dopo che il suo JavaScript ha girato.
 *      Diverso dal file che si ottiene con «salva pagina»: li' spesso i dati
 *      non ci sono ancora.
 *   2. l'elenco degli indirizzi gia' interrogati dalla pagina (dall'API
 *      Performance, che li conserva anche se lo script arriva dopo).
 *   3. il CORPO delle richieste che la pagina fara' DA ADESSO IN POI, perche'
 *      quelle gia' partite prima dell'incollaggio non si possono piu' leggere.
 *      Per questo dopo aver incollato conviene cambiare giornata e riesportare.
 *
 * Cosa NON raccoglie, deliberatamente: le intestazioni delle richieste. Li'
 * dentro ci sono i cookie di sessione, e un file che finisce in una chat non
 * e' il posto dove mettere le credenziali di qualcun altro. I parametri di
 * indirizzo che somigliano a un segreto vengono sostituiti.
 *
 * USO
 *   1. apri la pagina dei voti
 *   2. F12 → scheda Console
 *   3. incolla tutto questo file e premi Invio
 *      (Chrome la prima volta rifiuta l'incollaggio: scrivi  allow pasting
 *       nella console, Invio, e riprova)
 *   4. parte il salvataggio di `fantacomics-raccolta.json`
 *   5. se i voti si vedono a schermo ma il file risulta vuoto: cambia giornata
 *      sulla pagina, poi scrivi in console  fantacomicsEsporta()
 */
(() => {
  'use strict';

  const VERSIONE = 'raccolta-1';
  const MAX_CORPO = 2 * 1024 * 1024;

  if (window.__fantacomicsRaccoglitore) {
    console.log('%cRaccoglitore gia\' attivo.', 'font-weight:bold');
    window.fantacomicsEsporta();
    return;
  }

  /** Le richieste viste da quando lo script e' attivo, indirizzo → dati. */
  const registrate = new Map();

  /** Un indirizzo senza le parti che somigliano a un segreto. */
  function ripulisci(indirizzo) {
    try {
      const u = new URL(indirizzo, location.href);
      for (const chiave of [...u.searchParams.keys()]) {
        if (/token|auth|key|sess|pass|sig|jwt|secret/i.test(chiave)) {
          u.searchParams.set(chiave, 'RIMOSSO');
        }
      }
      return u.toString();
    } catch {
      return String(indirizzo);
    }
  }

  /**
   * I nomi che indicano una credenziale, non un dato.
   *
   * L'elenco e' CORTO e preciso di proposito. Una variante generosa — «tutto
   * cio' che contiene auth» — cancellerebbe anche `author`, e cancellare un
   * campo vero da un file che serve a leggere i nomi dei campi significa
   * consegnare un'analisi sbagliata per prudenza.
   */
  const SEGRETI = 'access_?token|auth_?token|authorization|api_?key|apikey|secret'
    + '|password|passwd|jwt|session_?id|sessionid|csrf_?token|xsrf|bearer|refresh_?token';

  /**
   * Toglie i valori delle credenziali da un testo, lasciando tutto il resto.
   *
   * Serve perche' la parte piu' preziosa del raccolto — gli script incorporati
   * nella pagina — e' anche quella dove i siti tengono il token di sessione e
   * l'identita' di chi e' collegato. Si sostituisce solo il VALORE: il nome
   * del campo resta, quindi chi legge l'analisi vede che quel campo esiste
   * senza riceverne il contenuto.
   *
   * Non e' una garanzia assoluta e non viene presentata come tale: un sito che
   * chiama la sua chiave `x7` non verrebbe colto da nessun elenco. Per questo
   * l'avviso a schermo resta anche quando la ripulitura ha funzionato.
   */
  function senzaSegreti(testo) {
    return String(testo)
      // "chiave": "valore"  /  chiave = 'valore'
      .replace(
        new RegExp(`(["']?[\\w-]*(?:${SEGRETI})["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, 'gi'),
        '$1$2RIMOSSO$2',
      )
      // ?chiave=valore dentro un indirizzo scritto nel testo
      .replace(new RegExp(`([?&][\\w-]*(?:${SEGRETI})[\\w-]*=)[^&"'\\s<]+`, 'gi'), '$1RIMOSSO');
  }

  /**
   * Vale la pena conservare il corpo?
   *
   * Immagini, font e fogli di stile passano di qui a centinaia e non
   * contengono voti. Il filtro e' sul tipo dichiarato, non sul nome
   * dell'indirizzo: un endpoint che restituisce JSON da un percorso che
   * finisce per `.aspx` va preso lo stesso.
   */
  function interessante(tipoContenuto) {
    return /json|javascript|text\/plain/i.test(tipoContenuto ?? '');
  }

  function annota(indirizzo, stato, tipoContenuto, corpo) {
    try {
      const pulito = ripulisci(indirizzo);
      registrate.set(pulito, {
        url: pulito,
        stato: stato ?? null,
        tipoContenuto: tipoContenuto ?? null,
        corpo: typeof corpo === 'string' && corpo.length <= MAX_CORPO ? senzaSegreti(corpo) : null,
        troncato: typeof corpo === 'string' && corpo.length > MAX_CORPO,
      });
    } catch { /* mai rompere la pagina di qualcun altro per un'annotazione */ }
  }

  // ── Registratore su fetch ────────────────────────────────────────────────
  const fetchOriginale = window.fetch;
  window.fetch = async function (...argomenti) {
    const risposta = await fetchOriginale.apply(this, argomenti);
    try {
      const tipo = risposta.headers.get('content-type');
      if (interessante(tipo)) {
        // `clone()` perche' il corpo si legge UNA volta sola: senza, la pagina
        // riceverebbe una risposta gia' consumata e smetterebbe di funzionare.
        risposta.clone().text().then(
          (t) => annota(risposta.url, risposta.status, tipo, t),
          () => annota(risposta.url, risposta.status, tipo, null),
        );
      } else {
        annota(risposta.url, risposta.status, tipo, null);
      }
    } catch { /* idem */ }
    return risposta;
  };

  // ── Registratore su XMLHttpRequest ───────────────────────────────────────
  const apriOriginale = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, indirizzo, ...resto) {
    this.__fcUrl = indirizzo;
    this.addEventListener('loadend', () => {
      try {
        const tipo = this.getResponseHeader('content-type');
        let corpo = null;
        // `responseText` LANCIA quando responseType e' 'json' o 'blob':
        // leggerlo senza guardia romperebbe ogni richiesta della pagina.
        if (this.responseType === '' || this.responseType === 'text') corpo = this.responseText;
        else if (this.responseType === 'json') corpo = JSON.stringify(this.response);
        annota(this.__fcUrl, this.status, tipo, interessante(tipo) ? corpo : null);
      } catch { /* idem */ }
    });
    return apriOriginale.call(this, metodo, indirizzo, ...resto);
  };

  /**
   * La pagina come si vede adesso, alleggerita.
   *
   * Si lavora su una COPIA: toccare il documento vero significherebbe rompere
   * la pagina di chi sta collaborando. Si toglie solo cio' che non puo'
   * contenere dati — stili, icone vettoriali, commenti, immagini incorporate —
   * e non si sceglie mai quale script tenere: quella scelta e' dell'analisi.
   */
  function pagina() {
    const copia = document.documentElement.cloneNode(true);
    copia.querySelectorAll('style,svg,noscript,link,iframe,source,script[src]').forEach((n) => n.remove());
    copia.querySelectorAll('[src^="data:"],[srcset]').forEach((n) => {
      n.removeAttribute('src');
      n.removeAttribute('srcset');
    });
    const passeggiata = document.createTreeWalker(copia, NodeFilter.SHOW_COMMENT);
    const commenti = [];
    while (passeggiata.nextNode()) commenti.push(passeggiata.currentNode);
    commenti.forEach((c) => c.remove());
    return senzaSegreti(`<!doctype html>\n${copia.outerHTML}`);
  }

  /** Gli indirizzi gia' interrogati prima che questo script esistesse. */
  function giaViste() {
    try {
      return performance.getEntriesByType('resource')
        .filter((r) => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
        .map((r) => ({ url: ripulisci(r.name), stato: null, tipoContenuto: null, corpo: null, troncato: false }));
    } catch {
      return [];
    }
  }

  function scarica(nome, testo) {
    const blob = new Blob([testo], { type: 'application/json' });
    const indirizzo = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = indirizzo;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(indirizzo), 10000);
  }

  window.fantacomicsEsporta = function () {
    const registrateOra = [...registrate.values()];
    const conosciute = new Set(registrateOra.map((r) => r.url));
    const rete = [...registrateOra, ...giaViste().filter((r) => !conosciute.has(r.url))];

    const raccolta = {
      fantacomics: VERSIONE,
      quando: new Date().toISOString(),
      indirizzo: ripulisci(location.href),
      titolo: document.title,
      pagina: pagina(),
      rete,
    };
    const testo = JSON.stringify(raccolta);
    window.RACCOLTA = raccolta;

    const conCorpo = rete.filter((r) => r.corpo).length;
    console.log(
      `%cFantaComics%c  pagina ${Math.round(raccolta.pagina.length / 1024)} KB · `
      + `${rete.length} indirizzi (${conCorpo} col contenuto) · file ${Math.round(testo.length / 1024)} KB`,
      'background:#111;color:#fff;padding:2px 6px;border-radius:3px',
      '',
    );
    if (conCorpo === 0) {
      console.log(
        'Nessuna risposta catturata: erano gia\' partite prima. Cambia giornata sulla '
        + 'pagina e poi riesegui  fantacomicsEsporta()',
      );
    }
    console.log(
      'Il file contiene la pagina come la vedi tu: cookie e intestazioni non ci sono, e i '
      + 'campi che si chiamano token, password o simili sono stati svuotati — ma se sei '
      + 'collegato al sito dentro puo\' comunque esserci il tuo nome. Dagli un\'occhiata.',
    );
    scarica('fantacomics-raccolta.json', testo);
    return raccolta;
  };

  window.__fantacomicsRaccoglitore = true;
  console.log('%cFantaComics%c  registratore attivo. Esporto adesso.',
    'background:#111;color:#fff;padding:2px 6px;border-radius:3px', '');
  window.fantacomicsEsporta();
})();
