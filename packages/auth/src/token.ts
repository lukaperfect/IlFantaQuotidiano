import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Token e firme.
 *
 * Due regole non negoziabili:
 * 1. i confronti di firma sono a tempo costante — un confronto con `===`
 *    perde informazione sul segreto un byte alla volta;
 * 2. i token di accesso si conservano SOLO come hash. Un archivio di magic
 *    link in chiaro è un archivio di password valide.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hash di conservazione per i token monouso. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual pretende lunghezze uguali: la differenza di lunghezza
  // va gestita prima, e non è un'informazione sensibile.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type SessionPayload = {
  accountId: string;
  /** Scadenza in millisecondi epoch. */
  expiresAt: number;
};

/** Sessione firmata: `base64url(json).firma`. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: 'malformato' | 'firma-non-valida' | 'scaduta' };

export function verifySession(
  cookie: string,
  secret: string,
  now = Date.now(),
): VerifyResult {
  const parts = cookie.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformato' };
  const [body, signature] = parts as [string, string];

  if (!safeEqual(signature, sign(body, secret))) {
    return { ok: false, reason: 'firma-non-valida' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { ok: false, reason: 'malformato' };
  }
  if (typeof payload.accountId !== 'string' || typeof payload.expiresAt !== 'number') {
    return { ok: false, reason: 'malformato' };
  }
  // La scadenza si verifica DOPO la firma: un payload non firmato non merita
  // che gli si guardi dentro.
  if (payload.expiresAt <= now) return { ok: false, reason: 'scaduta' };

  return { ok: true, payload };
}
