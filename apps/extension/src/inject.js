/**
 * IL PEZZO CHE VIVE NELLA PAGINA.
 *
 * Gira nel mondo MAIN, cioe' nello stesso contesto degli script del sito: e'
 * l'unico modo per vedere `fetch` e `XMLHttpRequest` della pagina. Il resto
 * dell'estensione sta nel mondo isolato e non condivide niente con questo, che
 * e' esattamente il confine che si vuole.
 *
 * COSA NON FA:
 * - non legge cookie, header, credenziali o corpi di richiesta;
 * - non fa richieste proprie: guarda solo risposte che la pagina ha gia'
 *   chiesto per conto suo, con l'IP e i tempi dell'utente. Non e' accesso
 *   automatizzato, e' leggere cio' che l'utente ha davanti;
 * - non manda NIENTE fuori dalla pagina se non corrisponde a una regola.
 *
 * LA FINESTRA CIECA, E PERCHE' ESISTE.
 * Le regole arrivano dal service worker, cioe' con un giro asincrono che dura
 * qualche millisecondo. Le richieste che una pagina fa mentre viene ancora
 * letta partono prima. La prima versione di questo file restava inerte fino
 * alle regole, ed era una scelta pulita sulla carta: in un browser vero non
 * intercettava niente: una fetch fatta dopo il carico veniva presa, le cinque
 * della pagina no.
 *
 * Quindi le risposte JSON che passano in quella finestra vengono TRATTENUTE
 * qui, dentro la memoria della pagina stessa, e non altrove: sono dati che la
 * pagina ha gia' ricevuto e che stanno gia' nel suo heap. Appena le regole
 * arrivano, quelle che non corrispondono vengono lasciate cadere senza essere
 * nemmeno lette. Se la risposta e' "disarmato", la coda si svuota subito.
 * La finestra dura il tempo di un messaggio, non di una sessione, e ha
 * comunque un tetto e una scadenza propri nel caso il service worker dorma.
 */
(() => {
  'use strict';

  const DA_PAGINA = 'fantacomics-pagina';
  const DA_ESTENSIONE = 'fantacomics-estensione';

  /** Quante risposte trattenere in attesa delle regole, e per quanto. */
  const TETTO_ATTESA = 60;
  const SCADENZA_ATTESA_MS = 5000;

  let regole = null;
  let spento = false;
  /** [{ url, leggi: () => Promise<unknown> }] — non ancora letti. */
  let attesa = [];

  const scadenza = setTimeout(() => { attesa = []; }, SCADENZA_ATTESA_MS);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.fonte !== DA_ESTENSIONE) return;

    if (d.tipo === 'regole' && Array.isArray(d.regole)) {
      regole = d.regole;
      spento = false;
      clearTimeout(scadenza);
      const parcheggiate = attesa;
      attesa = [];
      for (const v of parcheggiate) classifica(v.url, v.leggi);
    }

    if (d.tipo === 'disarma') {
      // Svuotare qui e' il punto: e' cio' che rende "Ferma" una cosa vera e
      // non un'etichetta sul popup.
      regole = null;
      spento = true;
      attesa = [];
      clearTimeout(scadenza);
    }
  });

  function regolaPer(url) {
    if (!regole) return null;
    return regole.find((r) => typeof url === 'string' && url.includes(r.urlContains)) ?? null;
  }

  function consegna(id, url, json) {
    // targetOrigin esplicito: un `*` manderebbe il contenuto a chiunque abbia
    // un riferimento a questa finestra, iframe di terzi compresi.
    window.postMessage({ fonte: DA_PAGINA, tipo: 'payload', id, url, json }, window.location.origin);
  }

  /** `leggi` e' pigra: una risposta che non corrisponde non viene mai letta. */
  function classifica(url, leggi) {
    if (spento) return;
    if (!regole) {
      if (attesa.length < TETTO_ATTESA) attesa.push({ url, leggi });
      return;
    }
    const regola = regolaPer(url);
    if (!regola) return;
    leggi().then((json) => consegna(regola.id, url, json)).catch(() => {});
  }

  function assoluto(url) {
    try { return new URL(url, window.location.href).href; } catch { return String(url); }
  }

  function sembraJson(headers) {
    try { return (headers.get('content-type') ?? '').includes('json'); } catch { return false; }
  }

  // --- fetch ---------------------------------------------------------------
  const fetchOriginale = window.fetch;
  window.fetch = function (...args) {
    const promessa = fetchOriginale.apply(this, args);
    try {
      const primo = args[0];
      const url = assoluto(typeof primo === 'string' ? primo : (primo && primo.url) || '');
      promessa.then((risposta) => {
        if (spento || !sembraJson(risposta.headers)) return;
        // `clone()` perche' un corpo si legge una volta sola: consumarlo qui
        // lo toglierebbe alla pagina, che smetterebbe di funzionare — e
        // un'estensione che rompe il sito viene disinstallata.
        const copia = risposta.clone();
        classifica(url, () => copia.json());
      }).catch(() => {});
    } catch { /* mai far fallire la fetch della pagina per colpa nostra */ }
    return promessa;
  };

  // --- XMLHttpRequest ------------------------------------------------------
  const openOriginale = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    try { this.__fcUrl = assoluto(url); } catch { /* ignora */ }
    return openOriginale.call(this, metodo, url, ...resto);
  };

  const sendOriginale = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const richiesta = this;
      richiesta.addEventListener('load', () => {
        try {
          if (spento) return;
          const tipo = richiesta.getResponseHeader('content-type') ?? '';
          if (!tipo.includes('json')) return;
          const testo = richiesta.responseType === '' || richiesta.responseType === 'text'
            ? richiesta.responseText
            : JSON.stringify(richiesta.response);
          classifica(richiesta.__fcUrl, () => Promise.resolve(JSON.parse(testo)));
        } catch { /* non era JSON: non ci riguarda */ }
      });
    } catch { /* ignora */ }
    return sendOriginale.apply(this, args);
  };
})();
