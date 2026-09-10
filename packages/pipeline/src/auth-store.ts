import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Account, AuthStore, MagicLink } from '@fantacomics/auth';

type AuthState = {
  accounts: Account[];
  links: MagicLink[];
  issued: Record<string, number>;
};

const VUOTO: AuthState = { accounts: [], links: [], issued: {} };

/**
 * Persistenza degli account su file.
 *
 * Stessa interfaccia che in produzione implementa Postgres. I magic link
 * scaduti vengono potati a ogni scrittura: un archivio che cresce all'infinito
 * di token, anche se solo hashati, e' superficie inutile.
 */
export class FileAuthStore implements AuthStore {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(resolve(this.root), 'auth.json');
  }

  private async read(): Promise<AuthState> {
    try {
      return { ...VUOTO, ...(JSON.parse(await readFile(this.file, 'utf8')) as AuthState) };
    } catch {
      return { ...VUOTO, accounts: [], links: [], issued: {} };
    }
  }

  private async write(state: AuthState, now = Date.now()): Promise<void> {
    const pruned: AuthState = {
      ...state,
      // Si tiene un'ora di margine oltre la scadenza: abbastanza per
      // rispondere "gia-usato" invece di "sconosciuto" a chi riclicca il link.
      links: state.links.filter((l) => l.expiresAt > now - 3_600_000),
    };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8');
  }

  async getAccountByEmail(email: string): Promise<Account | null> {
    return (await this.read()).accounts.find((a) => a.email === email) ?? null;
  }

  async getAccount(accountId: string): Promise<Account | null> {
    return (await this.read()).accounts.find((a) => a.accountId === accountId) ?? null;
  }

  async createAccount(account: Account): Promise<void> {
    const state = await this.read();
    if (state.accounts.some((a) => a.email === account.email)) return;
    await this.write({ ...state, accounts: [...state.accounts, account] });
  }

  async saveMagicLink(link: MagicLink): Promise<void> {
    const state = await this.read();
    await this.write({ ...state, links: [...state.links, link] });
  }

  async getMagicLink(tokenHash: string): Promise<MagicLink | null> {
    const link = (await this.read()).links.find((l) => l.tokenHash === tokenHash);
    if (!link) return null;
    // I link scritti prima che il legame col browser esistesse non hanno il
    // campo: valgono come "non legati", quindi passano dalla conferma.
    return { ...link, nonceHash: link.nonceHash ?? null };
  }

  async markMagicLinkUsed(tokenHash: string, usedAt: number): Promise<boolean> {
    const state = await this.read();
    const link = state.links.find((l) => l.tokenHash === tokenHash);
    // Il booleano qui e' onesto ma NON e' una garanzia: leggere, decidere e
    // scrivere su un file non e' atomico, quindi due richieste davvero
    // simultanee possono vederlo entrambe libero. La garanzia la da' Postgres
    // con `used_at is null` nella WHERE, e la differenza e' testata.
    if (!link || link.usedAt !== null) return false;
    await this.write({
      ...state,
      links: state.links.map((l) => (l.tokenHash === tokenHash ? { ...l, usedAt } : l)),
    });
    return true;
  }

  async lastIssuedAt(email: string): Promise<number | null> {
    return (await this.read()).issued[email] ?? null;
  }

  async recordIssued(email: string, at: number): Promise<void> {
    const state = await this.read();
    await this.write({ ...state, issued: { ...state.issued, [email]: at } });
  }
}
