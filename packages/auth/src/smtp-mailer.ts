/**
 * LA POSTA VERA.
 *
 * Finche' esistono solo `ConsoleMailer` e `FileMailer`, il magic link si
 * conosce solo guardando i log del server: l'app si puo' provare, non si puo'
 * aprire a nessuno. E' l'ultimo pezzo fra «gira» e «ci si registra».
 *
 * PERCHE' SMTP E NON L'API DI UN FORNITORE. Perche' SMTP lo parlano tutti —
 * la casella che si ha gia', il proprio dominio, e anche i fornitori
 * transazionali, che offrono tutti un accesso SMTP oltre alla loro API.
 * Scegliere l'API di uno significherebbe scegliere quel fornitore per conto di
 * chi possiede il prodotto, e cambiarlo diventerebbe un rilascio invece di una
 * variabile d'ambiente.
 *
 * Il limite va detto invece che scoperto: alcune piattaforme serverless
 * chiudono le porte SMTP in uscita. Se succede, la strada e' un mailer HTTP
 * accanto a questo — l'interfaccia e' gia' quella giusta, e il resto del
 * codice non se ne accorge.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer } from './account.js';

export type ConfigSmtp = {
  host: string;
  porta: number;
  utente: string;
  password: string;
  /**
   * Il mittente. Obbligatorio e separato dall'utente SMTP, perche' spesso
   * NON coincidono: si autentica `apikey` e si spedisce da
   * `noreply@dominio`. Sbagliarlo non da' un errore: da' una consegna che
   * finisce nello spam, cioe' un accesso che «non arriva» senza che niente
   * risulti rotto.
   */
  mittente: string;
  /**
   * TLS diretto. Vero sulla 465, falso sulla 587 dove si parte in chiaro e si
   * sale con STARTTLS. Si deduce dalla porta quando non e' detto, perche' e'
   * la domanda che tutti sbagliano e la risposta e' sempre la stessa.
   */
  sicuro?: boolean;
};

/**
 * Legge la configurazione dall'ambiente. Restituisce `null` se manca qualcosa,
 * invece di costruire un mailer a meta' che fallirebbe alla prima spedizione.
 */
export function configSmtpDaAmbiente(
  env: Record<string, string | undefined> = process.env,
): ConfigSmtp | null {
  const host = env.SMTP_HOST;
  const utente = env.SMTP_USER;
  const password = env.SMTP_PASSWORD;
  const mittente = env.SMTP_FROM;
  if (!host || !utente || !password || !mittente) return null;

  const porta = Number(env.SMTP_PORT ?? 587);
  if (!Number.isInteger(porta) || porta <= 0 || porta > 65535) return null;

  return {
    host,
    porta,
    utente,
    password,
    mittente,
    sicuro: env.SMTP_SICURO !== undefined ? env.SMTP_SICURO === '1' : porta === 465,
  };
}

export class SmtpMailer implements Mailer {
  private readonly trasporto: Transporter;

  constructor(private readonly config: ConfigSmtp, trasporto?: Transporter) {
    this.trasporto = trasporto ?? nodemailer.createTransport({
      host: config.host,
      port: config.porta,
      secure: config.sicuro ?? config.porta === 465,
      auth: { user: config.utente, pass: config.password },
    });
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    /**
     * Si spedisce in TESTO SEMPLICE, e non e' un ripiego.
     *
     * Una mail transazionale di due righe con dentro un collegamento passa i
     * filtri molto meglio in testo che in HTML, e qui non c'e' niente da
     * impaginare. Il giorno in cui servisse l'HTML, il posto e' questo.
     */
    await this.trasporto.sendMail({
      from: this.config.mittente,
      to,
      subject,
      text: body,
    });
  }

  /**
   * Prova la connessione e le credenziali SENZA spedire niente.
   *
   * Serve all'avvio: credenziali sbagliate scoperte al primo accesso di un
   * utente vero sono il momento peggiore per scoprirle, perche' quell'utente
   * non torna.
   */
  async verifica(): Promise<void> {
    await this.trasporto.verify();
  }
}
