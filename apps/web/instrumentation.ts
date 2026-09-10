import { signingSecret, usingDevSecret } from '@fantacomics/auth';

/**
 * Verifica di avvio.
 *
 * Senza questa, un'istanza con la configurazione sbagliata parte
 * tranquillamente e fallisce solo quando il primo utente prova ad accedere:
 * il momento peggiore per scoprirlo. Meglio non partire affatto.
 */
export function register(): void {
  // Vale solo sul runtime Node: l'edge non ha le stesse variabili.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  signingSecret(); // lancia in produzione se manca o è troppo corto

  if (usingDevSecret()) {
    console.warn(
      '[FantaComics] Segreto di sviluppo in uso: le sessioni non sono protette. ' +
      'Imposta FANTACOMICS_SECRET (almeno 32 caratteri) prima di esporre l’app.',
    );
  }
  if (!process.env.FANTACOMICS_URL) {
    console.warn(
      '[FantaComics] FANTACOMICS_URL non impostata: i magic link e le immagini ' +
      'di anteprima useranno http://localhost:3000.',
    );
  }
}
