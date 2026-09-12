/**
 * UN SERVER SMTP FINTO, MA CHE PARLA SMTP DAVVERO.
 *
 * Esiste per due usi che devono restare lo stesso codice: il test del mailer,
 * e le verifiche end-to-end che fanno partire l'app intera.
 *
 * PERCHE' SERVE ANCHE ALLE VERIFICHE. Da quando l'app in produzione si rifiuta
 * di partire senza posta configurata — e `next start` gira sempre con
 * `NODE_ENV=production` — una verifica end-to-end senza posta non parte
 * nemmeno. Le strade erano due: indebolire la garanzia con un'eccezione, o
 * dare alle verifiche una posta vera da usare. La prima avrebbe reso la
 * garanzia una decorazione: il caso che deve impedire — una macchina di
 * produzione che scrive i magic link su un file invece di spedirli — e'
 * esattamente il caso che l'eccezione avrebbe riaperto.
 *
 * Cio' che riceve lo scrive nello stesso registro del `FileMailer`, quindi le
 * verifiche che leggevano di li' continuano a leggere di li' — e adesso lo
 * fanno attraverso una vera conversazione SMTP invece che scavalcandola.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type MessaggioFinto = {
  mittente: string;
  destinatari: string[];
  /** Il messaggio come e' arrivato: intestazioni e corpo. */
  dati: string;
  /** Il solo corpo, con la codifica di trasporto sciolta. */
  corpo: string;
};

/**
 * Scioglie il quoted-printable.
 *
 * Non e' zelo: nodemailer ci passa il corpo appena compare un accento, e
 * spezza le righe lunghe con un `=` a fine riga. Un magic link che finisce a
 * cavallo di quella spezzatura non si riconosce piu', e la verifica direbbe
 * «nessun link trovato» dando la colpa alla posta invece che alla codifica.
 */
export function scioqliQuotedPrintable(testo: string): string {
  const senzaSpezzature = testo.replace(/=\r?\n/g, '');

  /**
   * I `=XX` si raccolgono come BYTE e si decodificano insieme alla fine.
   *
   * Tradurre ogni `=XX` nel suo carattere uno per uno e' l'errore naturale, ed
   * e' sbagliato: una lettera accentata in UTF-8 sono due byte — `é` e'
   * `=C3=A9` — e presi separatamente diventano «Ã©». Il difetto non si vedrebbe
   * sui magic link, che sono ASCII, ma su ogni oggetto in italiano.
   */
  const byte: number[] = [];
  for (let i = 0; i < senzaSpezzature.length; i++) {
    const c = senzaSpezzature[i] as string;
    const coppia = senzaSpezzature.slice(i + 1, i + 3);
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(coppia)) {
      byte.push(parseInt(coppia, 16));
      i += 2;
    } else {
      byte.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(byte).toString('utf8');
}

function corpoDi(dati: string): string {
  const vuota = dati.search(/\r?\n\r?\n/);
  const corpo = vuota < 0 ? dati : dati.slice(vuota).replace(/^\r?\n\r?\n/, '');
  return /quoted-printable/i.test(dati) ? scioqliQuotedPrintable(corpo) : corpo;
}

function intestazione(dati: string, nome: string): string {
  const m = new RegExp(`^${nome}:\\s*(.*)$`, 'im').exec(dati);
  return m?.[1]?.trim() ?? '';
}

export type SmtpFinto = {
  porta: number;
  ricevuti: MessaggioFinto[];
  chiudi: () => Promise<void>;
};

export async function avviaSmtpFinto(opzioni: {
  porta?: number;
  /** Registro JSONL, nella stessa forma del `FileMailer`. */
  registro?: string;
} = {}): Promise<SmtpFinto> {
  const ricevuti: MessaggioFinto[] = [];

  const server: Server = createServer((socket: Socket) => {
    let inDati = false;
    let corrente: MessaggioFinto = { mittente: '', destinatari: [], dati: '', corpo: '' };
    let resto = '';
    socket.write('220 finto ESMTP\r\n');

    socket.on('error', () => { /* un client che se ne va non e' un guasto */ });
    socket.on('data', (chunk) => {
      resto += chunk.toString('utf8');
      let i: number;
      while ((i = resto.indexOf('\r\n')) >= 0) {
        const riga = resto.slice(0, i);
        resto = resto.slice(i + 2);

        if (inDati) {
          if (riga === '.') {
            inDati = false;
            corrente.corpo = corpoDi(corrente.dati);
            ricevuti.push(corrente);
            if (opzioni.registro) scrivi(opzioni.registro, corrente);
            corrente = { mittente: '', destinatari: [], dati: '', corpo: '' };
            socket.write('250 preso\r\n');
          } else {
            // Il punto iniziale raddoppiato dal client va tolto, altrimenti
            // una riga del corpo che comincia per punto arriva alterata.
            corrente.dati += `${riga.startsWith('..') ? riga.slice(1) : riga}\n`;
          }
          continue;
        }

        const su = riga.toUpperCase();
        if (su.startsWith('EHLO') || su.startsWith('HELO')) {
          // Nessuno STARTTLS annunciato: si parla su un socket locale.
          socket.write('250-finto\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (su.trim() === 'AUTH LOGIN') {
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (su.startsWith('MAIL FROM')) {
          corrente.mittente = /<([^>]*)>/.exec(riga)?.[1] ?? '';
          socket.write('250 OK\r\n');
        } else if (su.startsWith('RCPT TO')) {
          corrente.destinatari.push(/<([^>]*)>/.exec(riga)?.[1] ?? '');
          socket.write('250 OK\r\n');
        } else if (su.startsWith('DATA')) {
          inDati = true;
          socket.write('354 avanti\r\n');
        } else if (su.startsWith('QUIT')) {
          socket.write('221 ciao\r\n');
          socket.end();
        } else if (su.startsWith('RSET') || su.startsWith('NOOP')) {
          socket.write('250 OK\r\n');
        } else {
          // Le credenziali in base64 arrivano come righe sciolte dopo un 334.
          socket.write('235 autenticato\r\n');
        }
      }
    });
  });

  /**
   * L'errore di `listen` si intercetta e si racconta.
   *
   * Senza, una porta gia' occupata esce come evento `error` non gestito: il
   * processo muore con una traccia di stack, e chi legge il log di una verifica
   * vede un guasto di Node invece di «quella porta e' presa».
   */
  const porta = await new Promise<number>((ok, no) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      no(e.code === 'EADDRINUSE'
        ? new Error(`La porta ${opzioni.porta ?? 0} e' gia' occupata: c'e' gia' una posta finta in ascolto?`)
        : e);
    });
    server.listen(opzioni.porta ?? 0, '127.0.0.1', () => {
      ok((server.address() as { port: number }).port);
    });
  });

  return {
    porta,
    ricevuti,
    chiudi: () => new Promise<void>((ok) => { server.close(() => { ok(); }); }),
  };
}

/**
 * Scrittura SINCRONA, per la stessa ragione del `FileMailer`: Node bufferizza
 * quando l'uscita non e' un terminale, e una verifica che aspetta di leggere
 * il link lo vedrebbe comparire a intervalli imprevedibili.
 */
function scrivi(percorso: string, m: MessaggioFinto): void {
  mkdirSync(dirname(percorso), { recursive: true });
  appendFileSync(percorso, `${JSON.stringify({
    to: m.destinatari.join(', '),
    subject: intestazione(m.dati, 'Subject'),
    body: m.corpo,
    at: new Date().toISOString(),
  })}\n`, 'utf8');
}
