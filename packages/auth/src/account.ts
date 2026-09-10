import { z } from 'zod';
import { hashToken, randomToken, safeEqual } from './token.js';

export const AccountSchema = z.object({
  accountId: z.string().min(1),
  /** Normalizzata: minuscola e senza spazi. È la chiave di identità. */
  email: z.string().email(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Account = z.infer<typeof AccountSchema>;

export type MagicLink = {
  /** SOLO l'hash. Il token in chiaro esiste una volta sola, al momento dell'invio. */
  tokenHash: string;
  /**
   * Hash del nonce messo nel cookie di chi ha CHIESTO il link. Lega il token
   * al browser richiedente: senza, chi riceve il link inoltrato entra
   * nell'account di chi gliel'ha mandato. `null` sui link emessi prima che
   * il legame esistesse, e per loro si passa dalla conferma esplicita.
   */
  nonceHash: string | null;
  accountId: string;
  expiresAt: number;
  usedAt: number | null;
};

export interface AuthStore {
  getAccountByEmail(email: string): Promise<Account | null>;
  getAccount(accountId: string): Promise<Account | null>;
  createAccount(account: Account): Promise<void>;
  saveMagicLink(link: MagicLink): Promise<void>;
  getMagicLink(tokenHash: string): Promise<MagicLink | null>;
  /**
   * Marca il link come speso e dice se e' stata QUESTA chiamata a marcarlo.
   * Il booleano non e' cosmetico: e' l'unico modo perche' il monouso lo
   * decida la scrittura invece di una lettura fatta un istante prima.
   */
  markMagicLinkUsed(tokenHash: string, usedAt: number): Promise<boolean>;
  /** Ultimo invio per quell'email: serve a non trasformare l'endpoint in un mortaio. */
  lastIssuedAt(email: string): Promise<number | null>;
  recordIssued(email: string, at: number): Promise<void>;
}

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Mailer di sviluppo: scrive il link sul log invece di spedirlo.
 * Come per il driver LLM, l'interfaccia è reale e l'implementazione offline
 * permette di far girare tutto il flusso senza dipendere da un provider.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (msg: string) => void = console.log) {}
  async send(to: string, subject: string, body: string): Promise<void> {
    this.log(`\n─── email a ${to} ───\n${subject}\n${body}\n───\n`);
  }
}

/**
 * Mailer che scrive su file in modo SINCRONO.
 *
 * Serve a ispezionare cio' che sarebbe stato spedito senza un provider. La
 * sincronia non e' pigrizia: Node bufferizza stdout quando non e' un
 * terminale, quindi un mailer che stampa e basta rende la consegna
 * osservabile solo a intervalli imprevedibili — inutile per verificare il
 * flusso di accesso.
 */
export class FileMailer implements Mailer {
  constructor(private readonly path: string) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(
      this.path,
      `${JSON.stringify({ to, subject, body, at: new Date().toISOString() })}\n`,
      'utf8',
    );
  }
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** Un invio ogni minuto per email. */
export const ISSUE_THROTTLE_MS = 60 * 1000;

export type IssueResult =
  | {
      ok: true;
      token: string;
      /** Da mettere in un cookie sul browser che ha chiesto il link. */
      nonce: string;
      accountId: string;
      nuovoAccount: boolean;
    }
  | { ok: false; reason: 'email-non-valida' | 'troppo-frequente' };

/**
 * Emette un magic link.
 *
 * Nota sulla risposta al chiamante: l'interfaccia non deve MAI rivelare se
 * l'email fosse già registrata. Sapere quali indirizzi esistono è già una
 * fuga di dati, e su un prodotto tra amici è pure imbarazzante.
 */
export async function issueMagicLink(
  store: AuthStore,
  rawEmail: string,
  opts: { now?: number; newId?: () => string } = {},
): Promise<IssueResult> {
  const now = opts.now ?? Date.now();
  const email = normalizeEmail(rawEmail);
  if (!z.string().email().safeParse(email).success) {
    return { ok: false, reason: 'email-non-valida' };
  }

  const last = await store.lastIssuedAt(email);
  if (last !== null && now - last < ISSUE_THROTTLE_MS) {
    return { ok: false, reason: 'troppo-frequente' };
  }

  let account = await store.getAccountByEmail(email);
  const nuovoAccount = account === null;
  if (!account) {
    account = AccountSchema.parse({
      accountId: `acc-${randomToken(9)}`,
      email,
      createdAt: new Date(now).toISOString(),
    });
    await store.createAccount(account);
  }

  const token = randomToken(32);
  // Il nonce lega il link al BROWSER che l'ha chiesto. Senza legame, un link
  // inoltrato a un estraneo apre nel suo browser una sessione sull'account di
  // chi gliel'ha mandato: da li' in poi tutto cio' che quell'estraneo carica
  // finisce in casa d'altri, ed e' lui a subirlo senza accorgersene.
  const nonce = randomToken(24);
  await store.saveMagicLink({
    tokenHash: hashToken(token),
    nonceHash: hashToken(nonce),
    accountId: account.accountId,
    expiresAt: now + MAGIC_LINK_TTL_MS,
    usedAt: null,
  });
  await store.recordIssued(email, now);

  return { ok: true, token, nonce, accountId: account.accountId, nuovoAccount };
}

export type ConsumeResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'sconosciuto' | 'gia-usato' | 'scaduto' };

/** Consuma un magic link. Monouso: un secondo tentativo fallisce sempre. */
export async function consumeMagicLink(
  store: AuthStore,
  token: string,
  opts: { now?: number } = {},
): Promise<ConsumeResult> {
  const now = opts.now ?? Date.now();
  const link = await store.getMagicLink(hashToken(token));
  if (!link) return { ok: false, reason: 'sconosciuto' };
  if (link.usedAt !== null) return { ok: false, reason: 'gia-usato' };
  if (link.expiresAt <= now) return { ok: false, reason: 'scaduto' };

  // La corsa la decide la scrittura, non la lettura qui sopra: se un'altra
  // richiesta ha speso il link nel frattempo, ha vinto lei e questa deve
  // fallire esattamente come se l'avesse trovato gia' usato.
  if (!(await store.markMagicLinkUsed(link.tokenHash, now))) {
    return { ok: false, reason: 'gia-usato' };
  }
  return { ok: true, accountId: link.accountId };
}

/** Il cookie di richiesta corrisponde al link? Confronto a tempo costante. */
export function nonceMatches(link: MagicLink, nonce: string | undefined): boolean {
  if (link.nonceHash === null || nonce === undefined || nonce === '') return false;
  return safeEqual(link.nonceHash, hashToken(nonce));
}

export type PeekResult =
  | { ok: true; accountId: string; stessoBrowser: boolean }
  | { ok: false; reason: 'sconosciuto' | 'gia-usato' | 'scaduto' };

/**
 * Guarda un link SENZA consumarlo, e dice se chi lo apre e' lo stesso browser
 * che l'ha chiesto.
 *
 * Serve alla pagina di conferma: un link che si spende per poter essere
 * mostrato e' gia' speso prima che l'utente confermi, quindi la lettura deve
 * poter avvenire senza consumo.
 */
export async function peekMagicLink(
  store: AuthStore,
  token: string,
  nonce: string | undefined,
  opts: { now?: number } = {},
): Promise<PeekResult> {
  const now = opts.now ?? Date.now();
  const link = await store.getMagicLink(hashToken(token));
  if (!link) return { ok: false, reason: 'sconosciuto' };
  if (link.usedAt !== null) return { ok: false, reason: 'gia-usato' };
  if (link.expiresAt <= now) return { ok: false, reason: 'scaduto' };
  return { ok: true, accountId: link.accountId, stessoBrowser: nonceMatches(link, nonce) };
}
