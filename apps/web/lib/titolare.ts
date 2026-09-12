/**
 * CHI GESTISCE IL SERVIZIO.
 *
 * E' un dato di configurazione, come tutto il resto: chi pubblica questo
 * progetto non deve modificare del codice per metterci il proprio nome, la
 * propria partita IVA e il proprio recapito.
 *
 * E soprattutto: finche' non e' compilato, le pagine legali lo DICONO in
 * pagina invece di far finta di essere complete. Termini e privacy con dentro
 * un segnaposto sembrano validi a chi li legge di sfuggita, ed e' esattamente
 * il momento in cui non lo sono.
 */
export type Titolare = {
  nome: string;
  piva: string;
  indirizzo: string;
  email: string;
};

export function titolare(
  env: Record<string, string | undefined> = process.env,
): Titolare | null {
  const nome = env.FANTACOMICS_TITOLARE?.trim();
  const piva = env.FANTACOMICS_PIVA?.trim();
  const indirizzo = env.FANTACOMICS_INDIRIZZO?.trim();
  const email = env.FANTACOMICS_EMAIL_CONTATTO?.trim();
  // Tutto o niente: dei termini con METa' dei dati del titolare sono peggio di
  // dei termini dichiaratamente incompleti, perche' non si vede che mancano.
  if (!nome || !piva || !indirizzo || !email) return null;
  return { nome, piva, indirizzo, email };
}

/** Il fornitore del modello, che va nominato: ci passano dei dati personali. */
export function fornitoreModello(env: Record<string, string | undefined> = process.env): string {
  return env.ANTHROPIC_API_KEY ? 'Anthropic PBC (Stati Uniti)' : 'nessuno: i testi sono generati localmente da un motore a modelli fissi';
}
