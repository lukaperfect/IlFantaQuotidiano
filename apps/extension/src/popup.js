/**
 * IL POPUP.
 *
 * Deve rendere ovvie tre cose: cosa e' stato catturato, cosa manca, e che
 * niente parte senza un gesto. La fiducia in un'estensione che legge pagine
 * altrui si costruisce mostrando esattamente cio' che fa, non promettendolo.
 */
const $ = (id) => document.getElementById(id);

async function schedaCorrente() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function messaggio(payload) {
  return new Promise((risolvi) => chrome.runtime.sendMessage(payload, risolvi));
}

function mostraEsito(testo, ok = true) {
  const box = $('esito');
  box.hidden = false;
  box.textContent = testo;
  box.style.borderLeftColor = ok ? '#2f6f4f' : '#8c1c13';
}

async function aggiorna() {
  const tab = await schedaCorrente();
  const stato = await messaggio({ tipo: 'stato', tabId: tab.id });
  if (!stato) return;

  const obbligatori = stato.obbligatori.length ? stato.obbligatori : ['voti', 'formazioni', 'calendario'];
  const tutti = [...new Set([...obbligatori, ...stato.catturati])];

  $('elenco').innerHTML = '';
  for (const id of tutti) {
    const li = document.createElement('li');
    const preso = stato.catturati.includes(id);
    li.innerHTML = `<span>${id}</span><span>${preso ? '✓' : (obbligatori.includes(id) ? 'manca' : '—')}</span>`;
    $('elenco').append(li);
  }

  const completo = obbligatori.every((id) => stato.catturati.includes(id));
  $('invia').disabled = !completo;
  // Completata la cattura, l'azione principale non e' piu' "Cattura".
  $('invia').classList.toggle('primario', completo);
  $('arma').classList.toggle('primario', !completo);
  if (stato.lega) $('esito').hidden = false, $('esito').textContent = `Lega collegata: ${stato.lega}`;
  if (stato.matchday) $('giornata').value = stato.matchday;
}

async function init() {
  const salvate = await chrome.storage.local.get({ server: 'http://localhost:3000', chiave: '' });
  $('server').value = salvate.server;
  $('chiave').value = salvate.chiave;

  $('salva').addEventListener('click', async () => {
    await chrome.storage.local.set({ server: $('server').value.trim(), chiave: $('chiave').value.trim() });
    mostraEsito('Salvato.');
  });

  $('arma').addEventListener('click', async () => {
    const tab = await schedaCorrente();
    const r = await messaggio({ tipo: 'arma', tabId: tab.id, matchday: Number($('giornata').value) });
    mostraEsito(r?.ok ? `Cattura attiva su ${r.regole} risposte. La pagina si ricarica.` : `Errore: ${r?.errore}`, !!r?.ok);
    setTimeout(aggiorna, 800);
  });

  $('disarma').addEventListener('click', async () => {
    const tab = await schedaCorrente();
    await messaggio({ tipo: 'disarma', tabId: tab.id });
    mostraEsito('Cattura ferma. Quello che era in memoria e’ stato buttato.');
    aggiorna();
  });

  $('invia').addEventListener('click', async () => {
    $('invia').disabled = true;
    const tab = await schedaCorrente();
    const r = await messaggio({ tipo: 'invia', tabId: tab.id });
    if (r?.ok) {
      const c = r.corpo ?? {};
      mostraEsito(`Fatto: ${c.squadre} squadre, giornata ${c.giornata}, confidenza ${c.confidenza}.`);
    } else {
      mostraEsito(`Non inviato: ${r?.errore ?? r?.corpo?.errore ?? 'errore sconosciuto'}`, false);
    }
    aggiorna();
  });

  aggiorna();
}

init();
