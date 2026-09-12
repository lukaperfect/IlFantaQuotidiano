/**
 * IL SERVICE WORKER.
 *
 * Tiene la chiave della lega, chiede al server quali risposte guardare,
 * raccoglie i payload e — solo quando l'utente lo dice — li manda al relay.
 *
 * Due regole di progetto che valgono piu' del codice:
 *
 * 1. NIENTE PARTE DA SOLO. La cattura si arma con un gesto e l'invio con un
 *    altro. Un'estensione che spedisce dati in sottofondo e' indistinguibile
 *    da uno spyware, indipendentemente dalle intenzioni di chi l'ha scritta.
 *
 * 2. LE REGOLE ARRIVANO DAL SERVER. Quali URL guardare non e' cablato qui: se
 *    la piattaforma cambia, si aggiorna il profilo lato server e alla
 *    riapertura l'estensione sa gia' cosa fare. L'alternativa — ricompilare,
 *    ripubblicare, aspettare l'aggiornamento automatico degli utenti —
 *    significa saltare una o due giornate, e su un prodotto settimanale
 *    saltare una giornata e' perdere l'abitudine.
 */

const PREDEFINITO = { server: 'http://localhost:3000', chiave: '', platform: 'portale-di-prova' };

/** Stato per scheda: cosa e' stato catturato e se la cattura e' armata. */
const schede = new Map();

function statoDi(tabId) {
  let s = schede.get(tabId);
  if (!s) { s = { armato: false, regole: [], payloads: {}, profilo: null }; schede.set(tabId, s); }
  return s;
}

async function impostazioni() {
  const salvate = await chrome.storage.local.get(PREDEFINITO);
  return { ...PREDEFINITO, ...salvate };
}

/** Chiede al server il profilo di piattaforma. La chiave e' l'autenticazione. */
async function scaricaProfilo() {
  const { server, chiave, platform } = await impostazioni();
  if (!chiave) throw new Error('Manca la chiave della lega.');

  const risposta = await fetch(`${server}/api/relay?platform=${encodeURIComponent(platform)}`, {
    headers: { authorization: `Bearer ${chiave}` },
  });
  const corpo = await risposta.json().catch(() => ({}));
  if (!risposta.ok) {
    throw new Error(corpo.errore ?? `Il server ha risposto ${risposta.status}.`);
  }
  await chrome.storage.local.set({ profilo: corpo, profiloScaricatoIl: new Date().toISOString() });
  return corpo;
}

async function arma(tabId, matchday) {
  const profilo = await scaricaProfilo();
  const s = statoDi(tabId);
  s.armato = true;
  s.regole = profilo.capture ?? [];
  s.profilo = profilo;
  s.matchday = matchday;
  s.payloads = {};

  // Ricaricare non e' pigrizia: garantisce che le regole siano in pagina prima
  // che partano le richieste, senza dover tenere da parte risposte che non
  // sappiamo ancora se ci riguardano.
  await chrome.tabs.reload(tabId);
  return profilo;
}

async function invia(tabId) {
  const s = statoDi(tabId);
  const { server, chiave, platform } = await impostazioni();
  const mancanti = (s.profilo?.obbligatori ?? []).filter((id) => !s.payloads[id]);
  if (mancanti.length > 0) {
    throw new Error(`Mancano ancora: ${mancanti.join(', ')}. Apri le pagine corrispondenti.`);
  }

  const envelope = {
    clientVersion: chrome.runtime.getManifest().version,
    platform,
    leagueExternalId: s.leagueExternalId ?? 'sconosciuto',
    matchday: Number(s.matchday),
    capturedAt: new Date().toISOString(),
    payloads: s.payloads,
  };

  const risposta = await fetch(`${server}/api/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${chiave}` },
    body: JSON.stringify(envelope),
  });
  const corpo = await risposta.json().catch(() => ({}));
  return { status: risposta.status, corpo };
}

chrome.runtime.onMessage.addListener((msg, sender, rispondi) => {
  const tabId = msg.tabId ?? sender.tab?.id;

  if (msg?.tipo === 'regole-per-questa-scheda') {
    const s = statoDi(tabId);
    rispondi({ armato: s.armato, regole: s.regole });
    return true;
  }

  if (msg?.tipo === 'payload') {
    const s = statoDi(tabId);
    if (!s.armato) return false;   // disarmati non si tiene niente
    s.payloads[msg.id] = msg.json;
    chrome.action.setBadgeText({ tabId, text: String(Object.keys(s.payloads).length) });
    return false;
  }

  if (msg?.tipo === 'stato') {
    const s = statoDi(msg.tabId);
    rispondi({
      armato: s.armato,
      matchday: s.matchday ?? '',
      catturati: Object.keys(s.payloads),
      obbligatori: s.profilo?.obbligatori ?? [],
      lega: s.profilo?.lega ?? null,
    });
    return true;
  }

  if (msg?.tipo === 'arma') {
    arma(msg.tabId, msg.matchday)
      .then((profilo) => rispondi({ ok: true, lega: profilo.lega, regole: profilo.capture.length }))
      .catch((e) => rispondi({ ok: false, errore: String(e.message ?? e) }));
    return true;
  }

  if (msg?.tipo === 'disarma') {
    const s = statoDi(msg.tabId);
    s.armato = false; s.payloads = {}; s.regole = [];
    chrome.tabs.sendMessage(msg.tabId, { tipo: 'disarma' }).catch(() => {});
    chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
    rispondi({ ok: true });
    return true;
  }

  if (msg?.tipo === 'invia') {
    invia(msg.tabId)
      .then((r) => rispondi({ ok: r.status === 200, ...r }))
      .catch((e) => rispondi({ ok: false, errore: String(e.message ?? e) }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => schede.delete(tabId));
