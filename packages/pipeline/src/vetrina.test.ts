import { describe, it, expect } from 'vitest';
import { puoCreareLegaDiProva, tettoLegheDiProva, MAX_LEGHE_DI_PROVA } from './vetrina.js';
import type { LeagueConfig } from './store.js';

const lega = (origine?: 'prova' | 'utente'): LeagueConfig => ({
  leagueId: `l-${Math.random()}`, ownerId: 'acc', publicSlug: 's', relaySecret: null,
  leagueName: 'x', ruleset: {} as LeagueConfig['ruleset'], spice: 2,
  createdAt: '2026-01-01T00:00:00.000Z', lastMatchday: null,
  ...(origine ? { origine } : {}),
});

describe('il tetto alle leghe di vetrina', () => {
  it('lascia passare finche\' si sta sotto', () => {
    expect(puoCreareLegaDiProva([], 2).puo).toBe(true);
    expect(puoCreareLegaDiProva([lega('prova')], 2).puo).toBe(true);
  });

  it('e ferma quando si e\' arrivati', () => {
    const esito = puoCreareLegaDiProva([lega('prova'), lega('prova')], 2);
    expect(esito.puo).toBe(false);
    // Il messaggio deve dire cosa fare, non solo cosa non si puo' fare.
    if (!esito.puo) expect(esito.motivo).toContain('file delle rose');
  });

  it('conta SOLO le leghe di vetrina', () => {
    // Le leghe vere dell'utente non devono consumare slot della vetrina:
    // chi porta i suoi dati sta pagando, e limitarlo sarebbe punire il cliente.
    const tante = [lega('utente'), lega('utente'), lega('utente'), lega('utente')];
    expect(puoCreareLegaDiProva(tante, 2).puo).toBe(true);
  });

  it('le leghe senza origine non occupano slot', () => {
    // Sono quelle scritte prima che il campo esistesse. Contarle come vetrina
    // chiuderebbe il cancello in faccia a chi non ha fatto niente.
    expect(puoCreareLegaDiProva([lega(), lega(), lega()], 2).puo).toBe(true);
  });

  it('un tetto a zero spegne la vetrina, e lo dice diversamente', () => {
    const esito = puoCreareLegaDiProva([], 0);
    expect(esito.puo).toBe(false);
    if (!esito.puo) expect(esito.motivo).toContain('disattivate');
  });
});

describe('il tetto dall\'ambiente', () => {
  it('senza niente configurato vale il predefinito', () => {
    expect(tettoLegheDiProva({})).toBe(MAX_LEGHE_DI_PROVA);
  });

  it('un numero lo cambia, zero compreso', () => {
    expect(tettoLegheDiProva({ FANTACOMICS_MAX_LEGHE_PROVA: '5' })).toBe(5);
    expect(tettoLegheDiProva({ FANTACOMICS_MAX_LEGHE_PROVA: '0' })).toBe(0);
  });

  it('un valore illeggibile NON spalanca il cancello', () => {
    // Il ripiego naturale — «non so leggerlo, lascio passare tutto» — e' il
    // modo piu' silenzioso di disattivare un limite che protegge una spesa.
    for (const v of ['tanto', '-1', '2.5', '']) {
      expect(tettoLegheDiProva({ FANTACOMICS_MAX_LEGHE_PROVA: v }), v).toBe(MAX_LEGHE_DI_PROVA);
    }
  });
});
