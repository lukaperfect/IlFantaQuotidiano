/**
 * Il mailer si verifica contro un SERVER SMTP vero, minimo ma vero: saluta,
 * autentica, riceve i comandi e il corpo. Una finzione di `nodemailer` direbbe
 * soltanto che la si e' chiamata — e cio' che si vuole sapere e' un'altra cosa:
 * che dall'altra parte arrivi un messaggio, col mittente giusto e col
 * collegamento dentro.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SmtpMailer, configSmtpDaAmbiente } from './smtp-mailer.js';
import { avviaSmtpFinto, scioqliQuotedPrintable, type SmtpFinto } from './smtp-finto.js';

/**
 * Il server finto e' lo STESSO che usano le verifiche end-to-end. Una copia
 * qui dentro proverebbe il mailer contro un interlocutore diverso da quello
 * con cui poi gira davvero.
 */
let finto: SmtpFinto;
beforeAll(async () => { finto = await avviaSmtpFinto(); });
afterAll(async () => { await finto.chiudi(); });

describe('SmtpMailer contro un server vero', () => {
  it('consegna il messaggio, col mittente configurato e il corpo intero', async () => {
    const mailer = new SmtpMailer({
      host: '127.0.0.1', porta: finto.porta,
      utente: 'utente', password: 'segreto',
      mittente: 'FantaComics <noreply@fantacomics.it>',
      sicuro: false,
    });
    await mailer.send('lettore@example.com', 'Il tuo accesso', 'Entra: https://x.it/accedi/abc');

    const r = finto.ricevuti.at(-1);
    expect(r).toBeDefined();
    // Il mittente della busta e' l'indirizzo configurato, NON l'utente SMTP:
    // sui fornitori transazionali i due quasi mai coincidono, e scambiarli
    // produce una consegna che finisce nello spam senza che niente sembri rotto.
    expect(r!.mittente).toBe('noreply@fantacomics.it');
    expect(r!.destinatari).toEqual(['lettore@example.com']);
    expect(r!.dati).toContain('Subject: Il tuo accesso');
    expect(r!.dati).toContain('https://x.it/accedi/abc');
  });

  it('il corpo viaggia in testo semplice', async () => {
    // Una transazionale di due righe passa i filtri meglio in testo, e qui non
    // c'e' niente da impaginare.
    const r = finto.ricevuti.at(-1)!;
    expect(r.dati).toContain('Content-Type: text/plain');
    expect(r.dati).not.toContain('text/html');
  });

  it('`verifica` prova le credenziali senza spedire niente', async () => {
    const prima = finto.ricevuti.length;
    const mailer = new SmtpMailer({
      host: '127.0.0.1', porta: finto.porta,
      utente: 'utente', password: 'segreto', mittente: 'a@b.it', sicuro: false,
    });
    await mailer.verifica();
    expect(finto.ricevuti.length).toBe(prima);
  });
});

describe('configurazione dall\'ambiente', () => {
  const pieno = {
    SMTP_HOST: 'smtp.esempio.it', SMTP_USER: 'u', SMTP_PASSWORD: 'p',
    SMTP_FROM: 'noreply@esempio.it',
  };

  it('senza uno solo dei campi non costruisce niente', () => {
    // Un mailer a meta' fallirebbe alla prima spedizione, cioe' al primo
    // accesso di qualcuno: meglio non averlo e dirlo.
    for (const manca of Object.keys(pieno)) {
      const parziale = { ...pieno, [manca]: undefined };
      expect(configSmtpDaAmbiente(parziale), manca).toBeNull();
    }
    expect(configSmtpDaAmbiente(pieno)).not.toBeNull();
  });

  it('deduce il TLS dalla porta, che e\' la domanda che tutti sbagliano', () => {
    expect(configSmtpDaAmbiente({ ...pieno, SMTP_PORT: '465' })?.sicuro).toBe(true);
    expect(configSmtpDaAmbiente({ ...pieno, SMTP_PORT: '587' })?.sicuro).toBe(false);
    // La porta predefinita e' la 587, quella con STARTTLS.
    expect(configSmtpDaAmbiente(pieno)?.porta).toBe(587);
    expect(configSmtpDaAmbiente(pieno)?.sicuro).toBe(false);
  });

  it('ma si puo\' dire esplicitamente, che vince sulla deduzione', () => {
    expect(configSmtpDaAmbiente({ ...pieno, SMTP_PORT: '587', SMTP_SICURO: '1' })?.sicuro).toBe(true);
    expect(configSmtpDaAmbiente({ ...pieno, SMTP_PORT: '465', SMTP_SICURO: '0' })?.sicuro).toBe(false);
  });

  it('una porta che non e\' una porta non passa', () => {
    for (const p of ['0', '-1', '70000', 'ottocento']) {
      expect(configSmtpDaAmbiente({ ...pieno, SMTP_PORT: p }), p).toBeNull();
    }
  });
});

describe('il registro della posta finta', () => {
  it('scioglie il quoted-printable, altrimenti un link spezzato non si legge', () => {
    // nodemailer codifica appena compare un accento e spezza le righe lunghe
    // con un `=` a fine riga. Un magic link a cavallo di quella spezzatura non
    // si riconosce piu', e la verifica darebbe la colpa alla posta invece che
    // alla codifica.
    const spezzato = 'Entra: http://localhost:3000/accedi/abcDEF=\r\n123ghi\r\nPerch=C3=A9 no';
    expect(scioqliQuotedPrintable(spezzato))
      .toBe('Entra: http://localhost:3000/accedi/abcDEF123ghi\r\nPerché no');
  });

  it('scrive nella stessa forma del FileMailer, cosi\' chi leggeva continua a leggere', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const registro = join(await mkdtemp(join(tmpdir(), 'fc-posta-')), 'posta.jsonl');

    const conRegistro = await avviaSmtpFinto({ registro });
    try {
      await new SmtpMailer({
        host: '127.0.0.1', porta: conRegistro.porta, utente: 'u', password: 'p',
        mittente: 'noreply@fantacomics.it', sicuro: false,
      }).send('tizio@example.com', 'Accèdi a FantaComics',
              'Entra: http://localhost:3000/accedi/UnTokenLungoAbbastanzaDaFarSpezzareLaRiga');

      const riga = JSON.parse((await readFile(registro, 'utf8')).trim()) as Record<string, string>;
      expect(riga.to).toBe('tizio@example.com');
      expect(riga.body).toContain(
        'http://localhost:3000/accedi/UnTokenLungoAbbastanzaDaFarSpezzareLaRiga',
      );
    } finally {
      await conRegistro.chiudi();
    }
  });
});
