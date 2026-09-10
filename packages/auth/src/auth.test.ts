import { describe, it, expect } from 'vitest';
import { signSession, verifySession, safeEqual, randomToken, hashToken } from './token.js';
import { signingSecret, usingDevSecret } from './secret.js';
import {
  issueMagicLink, consumeMagicLink, normalizeEmail, ConsoleMailer,
  MAGIC_LINK_TTL_MS, ISSUE_THROTTLE_MS,
  type Account, type AuthStore, type MagicLink,
} from './account.js';

const SEGRETO = 'x'.repeat(40);

class MemoryAuthStore implements AuthStore {
  readonly accounts = new Map<string, Account>();
  readonly links = new Map<string, MagicLink>();
  readonly issued = new Map<string, number>();

  async getAccountByEmail(email: string) {
    return [...this.accounts.values()].find((a) => a.email === email) ?? null;
  }
  async getAccount(id: string) { return this.accounts.get(id) ?? null; }
  async createAccount(a: Account) { this.accounts.set(a.accountId, a); }
  async saveMagicLink(l: MagicLink) { this.links.set(l.tokenHash, l); }
  async getMagicLink(h: string) { return this.links.get(h) ?? null; }
  async markMagicLinkUsed(h: string, usedAt: number) {
    const l = this.links.get(h);
    if (l) this.links.set(h, { ...l, usedAt });
  }
  async lastIssuedAt(email: string) { return this.issued.get(email) ?? null; }
  async recordIssued(email: string, at: number) { this.issued.set(email, at); }
}

describe('sessione firmata', () => {
  const payload = { accountId: 'acc-1', expiresAt: Date.now() + 60_000 };

  it('firma e verifica un giro completo', () => {
    const r = verifySession(signSession(payload, SEGRETO), SEGRETO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.accountId).toBe('acc-1');
  });

  it('rifiuta una firma prodotta con un altro segreto', () => {
    const cookie = signSession(payload, 'y'.repeat(40));
    const r = verifySession(cookie, SEGRETO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('firma-non-valida');
  });

  it('rifiuta un payload manomesso', () => {
    const cookie = signSession(payload, SEGRETO);
    const [, firma] = cookie.split('.');
    const falso = Buffer.from(JSON.stringify({ accountId: 'acc-vittima', expiresAt: Date.now() + 60_000 }))
      .toString('base64url');
    const r = verifySession(`${falso}.${firma}`, SEGRETO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('firma-non-valida');
  });

  it('rifiuta una sessione scaduta', () => {
    const cookie = signSession({ accountId: 'acc-1', expiresAt: 1000 }, SEGRETO);
    const r = verifySession(cookie, SEGRETO, 2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scaduta');
  });

  it('rifiuta cookie malformati senza esplodere', () => {
    for (const c of ['', 'senza-punto', 'a.b.c', '!!!.???']) {
      expect(verifySession(c, SEGRETO).ok).toBe(false);
    }
  });

  it('controlla la firma PRIMA della scadenza', () => {
    // Un payload non firmato non merita che gli si guardi dentro: se
    // l'ordine fosse invertito, un cookie forgiato e scaduto direbbe
    // "scaduta" invece di "firma-non-valida", rivelando che il payload
    // e' stato interpretato.
    const falso = Buffer.from(JSON.stringify({ accountId: 'x', expiresAt: 1 })).toString('base64url');
    const r = verifySession(`${falso}.firmafarlocca`, SEGRETO, 999_999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('firma-non-valida');
  });

  it('confronta le firme a tempo costante e gestisce lunghezze diverse', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('segreto di firma', () => {
  it('accetta un segreto abbastanza lungo', () => {
    expect(signingSecret({ FANTACOMICS_SECRET: SEGRETO } as NodeJS.ProcessEnv)).toBe(SEGRETO);
    expect(usingDevSecret({ FANTACOMICS_SECRET: SEGRETO } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('ripiega su un valore di sviluppo solo fuori produzione', () => {
    const dev = signingSecret({} as NodeJS.ProcessEnv);
    expect(dev.length).toBeGreaterThan(10);
    expect(usingDevSecret({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('in produzione l’assenza del segreto è un errore, non un degrado', () => {
    expect(() => signingSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(/FANTACOMICS_SECRET mancante/);
  });

  it('rifiuta un segreto troppo corto anche in sviluppo', () => {
    expect(() => signingSecret({ FANTACOMICS_SECRET: 'corto' } as NodeJS.ProcessEnv))
      .toThrow(/troppo corto/);
  });
});

describe('magic link', () => {
  const now = 1_700_000_000_000;

  it('emette un token e lo consuma una volta sola', async () => {
    const store = new MemoryAuthStore();
    const issued = await issueMagicLink(store, 'Mario@Example.COM ', { now });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const primo = await consumeMagicLink(store, issued.token, { now: now + 1000 });
    expect(primo).toEqual({ ok: true, accountId: issued.accountId });

    const secondo = await consumeMagicLink(store, issued.token, { now: now + 2000 });
    expect(secondo.ok).toBe(false);
    if (!secondo.ok) expect(secondo.reason).toBe('gia-usato');
  });

  it('conserva SOLO l’hash del token', async () => {
    const store = new MemoryAuthStore();
    const issued = await issueMagicLink(store, 'a@b.it', { now });
    if (!issued.ok) throw new Error('atteso ok');

    const salvati = JSON.stringify([...store.links.values()]);
    expect(salvati).not.toContain(issued.token);
    expect(store.links.has(hashToken(issued.token))).toBe(true);
  });

  it('rifiuta un token scaduto', async () => {
    const store = new MemoryAuthStore();
    const issued = await issueMagicLink(store, 'a@b.it', { now });
    if (!issued.ok) throw new Error('atteso ok');
    const r = await consumeMagicLink(store, issued.token, { now: now + MAGIC_LINK_TTL_MS + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scaduto');
  });

  it('rifiuta un token inventato', async () => {
    const store = new MemoryAuthStore();
    const r = await consumeMagicLink(store, randomToken(), { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('sconosciuto');
  });

  it('normalizza l’email e non duplica l’account', async () => {
    const store = new MemoryAuthStore();
    const primo = await issueMagicLink(store, 'Mario@Example.com', { now });
    const secondo = await issueMagicLink(store, '  mario@EXAMPLE.com ', { now: now + ISSUE_THROTTLE_MS });
    expect(primo.ok && secondo.ok).toBe(true);
    if (primo.ok && secondo.ok) {
      expect(secondo.accountId).toBe(primo.accountId);
      expect(primo.nuovoAccount).toBe(true);
      expect(secondo.nuovoAccount).toBe(false);
    }
    expect(store.accounts.size).toBe(1);
  });

  it('limita la frequenza di invio per email', async () => {
    const store = new MemoryAuthStore();
    await issueMagicLink(store, 'a@b.it', { now });
    const subito = await issueMagicLink(store, 'a@b.it', { now: now + 1000 });
    expect(subito.ok).toBe(false);
    if (!subito.ok) expect(subito.reason).toBe('troppo-frequente');

    const dopo = await issueMagicLink(store, 'a@b.it', { now: now + ISSUE_THROTTLE_MS });
    expect(dopo.ok).toBe(true);
  });

  it('rifiuta un’email non valida', async () => {
    const store = new MemoryAuthStore();
    const r = await issueMagicLink(store, 'non-una-email', { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('email-non-valida');
  });

  it('emette token diversi a ogni richiesta', async () => {
    const store = new MemoryAuthStore();
    const a = await issueMagicLink(store, 'a@b.it', { now });
    const b = await issueMagicLink(store, 'a@b.it', { now: now + ISSUE_THROTTLE_MS });
    if (a.ok && b.ok) expect(a.token).not.toBe(b.token);
  });
});

describe('normalizzazione e mailer', () => {
  it('normalizza spazi e maiuscole', () => {
    expect(normalizeEmail('  Mario@Example.COM ')).toBe('mario@example.com');
  });

  it('il mailer di sviluppo scrive il messaggio invece di spedirlo', async () => {
    const righe: string[] = [];
    await new ConsoleMailer((m) => righe.push(m)).send('a@b.it', 'Entra', 'https://link');
    expect(righe.join('')).toContain('a@b.it');
    expect(righe.join('')).toContain('https://link');
  });
});

describe('FileMailer', () => {
  it('scrive subito su file: la consegna è osservabile senza attendere un flush', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fc-mail-'));
    const file = join(dir, 'posta.log');

    const { FileMailer } = await import('./account.js');
    await new FileMailer(file).send('a@b.it', 'Oggetto', 'https://link/abc');

    const righe = (await readFile(file, 'utf8')).trim().split('\n');
    expect(righe).toHaveLength(1);
    const messaggio = JSON.parse(righe[0] as string) as { to: string; body: string };
    expect(messaggio.to).toBe('a@b.it');
    expect(messaggio.body).toContain('https://link/abc');
    await rm(dir, { recursive: true, force: true });
  });
});
