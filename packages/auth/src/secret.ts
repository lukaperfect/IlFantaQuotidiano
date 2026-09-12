/**
 * Il segreto di firma.
 *
 * Un default di sviluppo che funziona anche in produzione è la vulnerabilità
 * classica: nessuno se ne accorge finché qualcuno non forgia una sessione.
 * Qui il fallback esiste SOLO fuori produzione, e in produzione l'assenza del
 * segreto è un errore all'avvio, non un degrado silenzioso.
 */
const SVILUPPO = 'fantacomics-sviluppo-non-usare-in-produzione';

export function signingSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.FANTACOMICS_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'FANTACOMICS_SECRET mancante o troppo corto (servono almeno 32 caratteri). ' +
      'In produzione non esiste un valore di ripiego: senza segreto le sessioni ' +
      'sarebbero forgiabili da chiunque.',
    );
  }
  if (secret) {
    throw new Error(
      `FANTACOMICS_SECRET troppo corto (${secret.length} caratteri, ne servono almeno 32).`,
    );
  }
  return SVILUPPO;
}

/** Vero quando si sta girando con il segreto di sviluppo: da mostrare nell'interfaccia. */
export function usingDevSecret(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.FANTACOMICS_SECRET;
}
