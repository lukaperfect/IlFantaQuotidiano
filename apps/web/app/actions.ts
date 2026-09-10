'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { DEFAULT_RULESET, LeagueRulesetSchema, safeName, stableHash } from '@fantacomics/core';
import { importFromFiles, generateWorld, withOfficialScores, nudgeTeamToScore } from '@fantacomics/ingest';
import { runMatchdayPipeline } from '@fantacomics/pipeline';
import { TemplateDriver, AnthropicDriver } from '@fantacomics/llm';
import { store } from '@/lib/store';

function driver() {
  // Senza chiave si usa il driver template: il giornale esce comunque, piu'
  // secco. Un prodotto settimanale che salta una settimana perde gli abbonati.
  return process.env.ANTHROPIC_API_KEY ? new AnthropicDriver() : new TemplateDriver();
}

async function fileText(form: FormData, field: string): Promise<string> {
  const value = form.get(field);
  if (value instanceof File) return value.size > 0 ? value.text() : '';
  return typeof value === 'string' ? value : '';
}

/** Crea una lega dai CSV esportati dalla piattaforma. */
export async function creaLegaDaFile(form: FormData): Promise<void> {
  const leagueName = safeName(String(form.get('leagueName') ?? ''), 60);
  const matchday = Number(form.get('matchday') ?? 1);
  const season = String(form.get('season') ?? '2025-26');
  const spice = Number(form.get('spice') ?? 2) as 1 | 2 | 3;

  const [votiCsv, formazioniCsv, calendarioCsv, roseCsv, classificaCsv] = await Promise.all([
    fileText(form, 'voti'), fileText(form, 'formazioni'), fileText(form, 'calendario'),
    fileText(form, 'rose'), fileText(form, 'classifica'),
  ]);

  const leagueId = `lega-${stableHash(`${leagueName}:${season}`)}`;
  const { serieA, snapshot } = importFromFiles({
    season, matchday, leagueId, leagueName,
    votiCsv, formazioniCsv, calendarioCsv,
    ...(roseCsv ? { roseCsv } : {}),
    ...(classificaCsv ? { classificaCsv } : {}),
  });

  await store.saveConfig({
    leagueId, leagueName, ruleset: DEFAULT_RULESET, spice,
    createdAt: new Date().toISOString(), lastMatchday: null,
  });

  await runMatchdayPipeline({
    snapshot, serieA, rules: DEFAULT_RULESET, store, driver: driver(), spice,
  });

  revalidatePath('/');
  redirect(`/lega/${leagueId}`);
}

/**
 * Lega di prova con dati generati.
 * Non e' una scorciatoia da demo: e' l'onboarding. Chiedere a un admin di
 * esportare cinque CSV prima di avergli fatto vedere il prodotto e' il modo
 * piu' sicuro di perderlo.
 */
export async function creaLegaDiProva(form: FormData): Promise<void> {
  const leagueName = safeName(String(form.get('leagueName') ?? 'Lega di prova'), 60);
  const teams = Math.max(4, Math.min(12, Number(form.get('teams') ?? 8)));
  const spice = Number(form.get('spice') ?? 2) as 1 | 2 | 3;
  const leagueId = `prova-${stableHash(`${leagueName}:${Date.now()}`)}`;

  await store.saveConfig({
    leagueId, leagueName, ruleset: DEFAULT_RULESET, spice,
    createdAt: new Date().toISOString(), lastMatchday: null,
  });

  // Tre giornate: con una sola non esistono archi narrativi da raccontare.
  for (let matchday = 1; matchday <= 3; matchday++) {
    let world = generateWorld({
      seed: `${leagueId}-${matchday}`, teams, matchday,
      scenarios: { formazioneNonSchierata: matchday === 2 },
    });
    if (matchday === 3) world = nudgeTeamToScore(world, 't1', 71.5, DEFAULT_RULESET, { strict: false });
    world = withOfficialScores(world, DEFAULT_RULESET);

    await runMatchdayPipeline({
      snapshot: { ...world.snapshot, leagueId, leagueName },
      serieA: world.serieA, rules: DEFAULT_RULESET, store, driver: driver(), spice,
    });
  }

  revalidatePath('/');
  redirect(`/lega/${leagueId}`);
}

export type EsitoConfigurazione = { ok: boolean; messaggio: string };

/**
 * Aggiorna regolamento e piccante.
 *
 * Restituisce un esito invece di reindirizzare con un parametro in query:
 * quel giro dipendeva dal fatto che la navigazione conservasse la query, e
 * lasciava l'admin senza conferma quando non succedeva. Un salvataggio muto
 * su una schermata di configurazione e' peggio di un errore visibile.
 */
export async function salvaConfigurazione(
  _precedente: EsitoConfigurazione | null,
  form: FormData,
): Promise<EsitoConfigurazione> {
  const leagueId = String(form.get('leagueId') ?? '');
  const config = await store.getConfig(leagueId);
  if (!config) return { ok: false, messaggio: 'Lega non trovata.' };

  try {
    const ruleset = LeagueRulesetSchema.parse({
      ...config.ruleset,
      version: config.ruleset.version + 1,
      goalThreshold: {
        base: Number(form.get('sogliaBase') ?? config.ruleset.goalThreshold.base),
        step: Number(form.get('sogliaStep') ?? config.ruleset.goalThreshold.step),
      },
      useAssists: form.get('assist') === 'on',
      defenseModifier: {
        ...config.ruleset.defenseModifier,
        enabled: form.get('modificatore') === 'on',
      },
      captain: { ...config.ruleset.captain, enabled: form.get('capitano') === 'on' },
    });

    await store.saveConfig({
      ...config,
      ruleset,
      spice: Number(form.get('spice') ?? config.spice) as 1 | 2 | 3,
    });

    revalidatePath(`/lega/${leagueId}`);
    return {
      ok: true,
      messaggio: `Salvato. Regolamento versione ${ruleset.version}, vale dalla prossima edizione.`,
    };
  } catch (e) {
    return {
      ok: false,
      messaggio: e instanceof Error ? `Regolamento non valido: ${e.message}` : 'Errore sconosciuto.',
    };
  }
}
