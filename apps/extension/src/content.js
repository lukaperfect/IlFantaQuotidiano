/**
 * IL PONTE.
 *
 * Gira nel mondo isolato: vede il DOM ma non le variabili della pagina, e
 * puo' parlare con il service worker. Il pezzo nel mondo MAIN non puo' fare
 * ne' l'uno ne' l'altro, ed e' per questo che sono due file.
 *
 * Passa solo due cose: le regole verso la pagina, i payload verso il service
 * worker. Non interpreta niente — l'interpretazione sta sul server, dove si
 * puo' correggere senza ripubblicare l'estensione.
 */
(() => {
  'use strict';

  const DA_PAGINA = 'fantacomics-pagina';
  const DA_ESTENSIONE = 'fantacomics-estensione';

  /**
   * Si chiede al service worker se questa scheda e' armata, e si risponde alla
   * pagina SEMPRE — anche quando non lo e'.
   *
   * Rispondere anche di no non e' pedanteria: e' cio' che chiude subito la
   * finestra in cui il pezzo nella pagina trattiene le risposte in attesa di
   * sapere se gli interessano. Restando zitti, quella finestra resterebbe
   * aperta fino alla scadenza a ogni caricamento di pagina.
   */
  function armaSePrevisto() {
    chrome.runtime.sendMessage({ tipo: 'regole-per-questa-scheda' }, (risposta) => {
      if (chrome.runtime.lastError) return;
      const armato = !!risposta?.armato;
      window.postMessage(
        armato
          ? { fonte: DA_ESTENSIONE, tipo: 'regole', regole: risposta.regole }
          : { fonte: DA_ESTENSIONE, tipo: 'disarma' },
        window.location.origin,
      );
    });
  }

  // Il service worker puo' armare la cattura mentre la pagina e' gia' aperta.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.tipo === 'arma') {
      window.postMessage(
        { fonte: DA_ESTENSIONE, tipo: 'regole', regole: msg.regole },
        window.location.origin,
      );
    }
    if (msg?.tipo === 'disarma') {
      window.postMessage({ fonte: DA_ESTENSIONE, tipo: 'disarma' }, window.location.origin);
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.fonte !== DA_PAGINA || d.tipo !== 'payload') return;
    chrome.runtime.sendMessage({ tipo: 'payload', id: d.id, url: d.url, json: d.json });
  });

  armaSePrevisto();
})();
