import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  signSession, verifySession, signingSecret, type Account,
} from '@fantacomics/auth';
import { authStore } from './store';

const COOKIE = 'fc_sess';
const DURATA_MS = 30 * 24 * 60 * 60 * 1000;

export async function startSession(accountId: string): Promise<void> {
  const value = signSession(
    { accountId, expiresAt: Date.now() + DURATA_MS },
    signingSecret(),
  );
  (await cookies()).set(COOKIE, value, {
    httpOnly: true,                                  // fuori dalla portata di document.cookie
    sameSite: 'lax',                                 // il magic link arriva da un click esterno
    secure: process.env.NODE_ENV === 'production',   // in chiaro solo in sviluppo locale
    path: '/',
    maxAge: Math.floor(DURATA_MS / 1000),
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** L'account della richiesta corrente, o null. Non reindirizza. */
export async function currentAccount(): Promise<Account | null> {
  const cookie = (await cookies()).get(COOKIE)?.value;
  if (!cookie) return null;

  const verified = verifySession(cookie, signingSecret());
  if (!verified.ok) return null;

  // La sessione e' firmata, ma l'account puo' essere sparito: la firma prova
  // l'autenticita' del cookie, non l'esistenza di chi lo porta.
  return authStore.getAccount(verified.payload.accountId);
}

/** L'account, oppure si va al login. È la guardia delle pagine private. */
export async function requireAccount(): Promise<Account> {
  const account = await currentAccount();
  if (!account) redirect('/accedi');
  return account;
}
