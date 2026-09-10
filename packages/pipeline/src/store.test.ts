import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULESET } from '@fantacomics/core';
import { issueMagicLink, consumeMagicLink, hashToken } from '@fantacomics/auth';
import { FileLeagueStore } from './store.js';
import { FileAuthStore } from './auth-store.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fc-store-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const lega = (over: Record<string, unknown> = {}) => ({
  leagueId: 'lega-1', ownerId: 'acc-mario', publicSlug: 'slug-lungo-e-casuale',
  leagueName: 'Lega Uno', ruleset: DEFAULT_RULESET, spice: 2 as const,
  createdAt: '2026-01-01T00:00:00Z', lastMatchday: null, ...over,
});

describe('FileLeagueStore — proprietà e slug', () => {
  it('sopravvive a un riavvio: rilegge ciò che ha scritto', async () => {
    await new FileLeagueStore(root).saveConfig(lega());
    const altro = new FileLeagueStore(root);
    expect((await altro.getConfigForOwner('lega-1', 'acc-mario'))?.leagueName).toBe('Lega Uno');
    expect(await altro.listLeagues('acc-mario')).toHaveLength(1);
  });

  it('isola i proprietari anche su disco', async () => {
    const store = new FileLeagueStore(root);
    await store.saveConfig(lega());
    await store.saveConfig(lega({ leagueId: 'lega-2', ownerId: 'acc-giulia', publicSlug: 'slug-due' }));

    expect((await store.listLeagues('acc-mario')).map((l) => l.leagueId)).toEqual(['lega-1']);
    expect(await store.getConfigForOwner('lega-2', 'acc-mario')).toBeNull();
  });

  it('rigenerare lo slug revoca il precedente', async () => {
    // Revocare significa togliere il vecchio, non solo aggiungere il nuovo:
    // se il vecchio continuasse a funzionare la revoca sarebbe finta.
    const store = new FileLeagueStore(root);
    await store.saveConfig(lega());
    expect(await store.getConfigBySlug('slug-lungo-e-casuale')).not.toBeNull();

    await store.saveConfig(lega({ publicSlug: 'slug-nuovo-di-zecca' }));
    expect(await store.getConfigBySlug('slug-lungo-e-casuale')).toBeNull();
    expect((await store.getConfigBySlug('slug-nuovo-di-zecca'))?.leagueId).toBe('lega-1');
  });

  it('uno slug sconosciuto non apre nulla', async () => {
    const store = new FileLeagueStore(root);
    await store.saveConfig(lega());
    expect(await store.getConfigBySlug('slug-inventato')).toBeNull();
  });
});

describe('FileAuthStore', () => {
  it('completa il giro emissione → consumo attraverso il disco', async () => {
    const store = new FileAuthStore(root);
    const issued = await issueMagicLink(store, 'mario@example.com');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // Un'altra istanza: simula il processo riavviato tra il click e l'invio.
    const altro = new FileAuthStore(root);
    const r = await consumeMagicLink(altro, issued.token);
    expect(r).toEqual({ ok: true, accountId: issued.accountId });
    expect((await altro.getAccount(issued.accountId))?.email).toBe('mario@example.com');
  });

  it('non scrive mai il token in chiaro su disco', async () => {
    const store = new FileAuthStore(root);
    const issued = await issueMagicLink(store, 'a@b.it');
    if (!issued.ok) throw new Error('atteso ok');

    const { readFile } = await import('node:fs/promises');
    const contenuto = await readFile(join(root, 'auth.json'), 'utf8');
    expect(contenuto).not.toContain(issued.token);
    expect(contenuto).toContain(hashToken(issued.token));
  });

  it('non duplica l’account sulla stessa email', async () => {
    const store = new FileAuthStore(root);
    await issueMagicLink(store, 'a@b.it', { now: 1000 });
    await issueMagicLink(store, 'a@b.it', { now: 1000 + 60_000 });
    const { readFile } = await import('node:fs/promises');
    const state = JSON.parse(await readFile(join(root, 'auth.json'), 'utf8')) as { accounts: unknown[] };
    expect(state.accounts).toHaveLength(1);
  });

  it('un link usato resta rifiutato dopo il riavvio', async () => {
    const store = new FileAuthStore(root);
    const issued = await issueMagicLink(store, 'a@b.it');
    if (!issued.ok) throw new Error('atteso ok');
    await consumeMagicLink(store, issued.token);

    const r = await consumeMagicLink(new FileAuthStore(root), issued.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('gia-usato');
  });
});
