import { signingSecret, usingDevSecret, configSmtpDaAmbiente } from '@fantacomics/auth';

/**
 * Verifica di avvio.
 *
 * Senza questa, un'istanza con la configurazione sbagliata parte
 * tranquillamente e fallisce solo quando il primo utente prova ad accedere:
 * il momento peggiore per scoprirlo. Meglio non partire affatto.
 */
export async function register(): Promise<void> {
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

  /**
   * LA POSTA SI CONTROLLA ALL'AVVIO, non al primo accesso.
   *
   * Senza un mailer vero il magic link finisce su un file o su un log, e
   * l'utente vede «ti abbiamo mandato una mail» e non riceve niente. Non e' un
   * errore che qualcuno segnala: e' un utente che non torna. In produzione
   * quindi l'app NON parte, come per il segreto di firma — e non parte
   * nemmeno se le credenziali SMTP sono sbagliate, perche' scoprirlo al primo
   * accesso di un utente vero e' il momento peggiore per scoprirlo.
   */
  const smtp = configSmtpDaAmbiente();
  if (process.env.NODE_ENV === 'production' && !smtp) {
    throw new Error(
      '[FantaComics] Nessuna posta configurata: i magic link non verrebbero ' +
      'spediti. Imposta SMTP_HOST, SMTP_USER, SMTP_PASSWORD e SMTP_FROM.',
    );
  }
  if (smtp) {
    const { SmtpMailer } = await import('@fantacomics/auth');
    try {
      await new SmtpMailer(smtp).verifica();
      console.log(`[FantaComics] Posta via ${smtp.host}:${smtp.porta}, mittente ${smtp.mittente}.`);
    } catch (e) {
      throw new Error(
        `[FantaComics] SMTP non raggiungibile o credenziali rifiutate (${smtp.host}:${smtp.porta}): ` +
        `${e instanceof Error ? e.message : 'errore sconosciuto'}`,
      );
    }
  } else {
    console.warn(
      '[FantaComics] Nessuna posta configurata: i magic link restano nei log. ' +
      'Va bene in sviluppo, non con utenti veri.',
    );
  }

  /**
   * Lo schema si applica all'avvio, una volta sola, e non alla prima
   * richiesta: se il database non e' raggiungibile o la migrazione fallisce,
   * e' meglio non partire che servire errori a caso.
   */
  const { pool, usingPostgres } = await import('@/lib/store');
  if (usingPostgres && pool) {
    const { migrate } = await import('@fantacomics/pipeline');
    await migrate(pool);
    console.log('[FantaComics] Persistenza su Postgres, schema applicato.');
  } else {
    console.warn(
      '[FantaComics] Persistenza su file: adatta allo sviluppo, non a un ' +
      'container effimero. Imposta DATABASE_URL per usare Postgres.',
    );
  }
}
