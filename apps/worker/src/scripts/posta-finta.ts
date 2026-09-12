/**
 * LA POSTA FINTA, IN PIEDI DA SOLA.
 *
 * Serve alle verifiche end-to-end, che fanno partire l'app vera: da quando
 * l'app in produzione si rifiuta di partire senza posta configurata — e
 * `next start` gira sempre in produzione — senza qualcuno che risponda su SMTP
 * non parte piu' niente.
 *
 * Cio' che riceve finisce in `FANTACOMICS_MAIL_LOG`, nella stessa forma che
 * scriveva il `FileMailer`. Le verifiche che leggevano di li' continuano a
 * leggere di li', e adesso lo fanno attraverso una conversazione SMTP vera
 * invece di scavalcarla: il percorso della posta e' passato da «non
 * verificato» a «verificato a ogni giro».
 *
 *   SMTP_PORT=4176 FANTACOMICS_MAIL_LOG=/tmp/posta.jsonl \
 *     pnpm exec tsx apps/worker/src/scripts/posta-finta.ts
 */

import { writeSync } from 'node:fs';
import { avviaSmtpFinto } from '@fantacomics/auth';

const porta = Number(process.env.SMTP_PORT ?? 4176);
const registro = process.env.FANTACOMICS_MAIL_LOG;

const finto = await avviaSmtpFinto({ porta, ...(registro ? { registro } : {}) });

/**
 * Si scrive in modo SINCRONO, non con `console.log`.
 *
 * Node bufferizza stdout quando non e' un terminale, quindi in CI — dove
 * questo processo resta vivo e il log si legge da un altro passo — la riga
 * d'avvio comparirebbe a intervalli imprevedibili, o mai. Il controllo che
 * verifica che la posta sia partita darebbe un falso guasto. E' lo stesso
 * motivo per cui il FileMailer scrive sincrono, ed e' costato un giro
 * scoprirlo di nuovo qui.
 */
writeSync(1,
  `posta finta su 127.0.0.1:${finto.porta}`
  + (registro ? ` → ${registro}` : ' (senza registro: i messaggi restano in memoria)')
  + '\n');

for (const segnale of ['SIGINT', 'SIGTERM'] as const) {
  process.on(segnale, () => {
    void finto.chiudi().then(() => process.exit(0));
  });
}
