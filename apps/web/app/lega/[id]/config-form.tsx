'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { LeagueConfig } from '@fantacomics/pipeline';
import { salvaConfigurazione, type EsitoConfigurazione } from '@/app/actions';

function Salva() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? 'Salvataggio…' : 'Salva'}
    </button>
  );
}

export function ConfigForm({ config }: { config: LeagueConfig }) {
  const [esito, azione] = useActionState<EsitoConfigurazione | null, FormData>(
    salvaConfigurazione, null,
  );

  return (
    <form action={azione}>
      <input type="hidden" name="leagueId" value={config.leagueId} />

      {esito ? (
        <p className={esito.ok ? 'notice' : 'notice error'} role="status">{esito.messaggio}</p>
      ) : null}

      <div className="row">
        <label style={{ flex: 1 }}>
          Soglia primo gol
          <input name="sogliaBase" type="number" step="0.5"
                 defaultValue={config.ruleset.goalThreshold.base} />
        </label>
        <label style={{ flex: 1 }}>
          Punti per gol successivo
          <input name="sogliaStep" type="number" step="0.5"
                 defaultValue={config.ruleset.goalThreshold.step} />
        </label>
        <label style={{ flex: 1 }}>
          Piccante
          <select name="spice" defaultValue={String(config.spice)}>
            <option value="1">1 · bonario</option>
            <option value="2">2 · standard</option>
            <option value="3">3 · pungente</option>
          </select>
        </label>
      </div>

      <fieldset>
        <legend>Opzioni</legend>
        <label className="check">
          <input type="checkbox" name="assist" defaultChecked={config.ruleset.useAssists} />
          Bonus assist
        </label>
        <label className="check">
          <input type="checkbox" name="modificatore"
                 defaultChecked={config.ruleset.defenseModifier.enabled} />
          Modificatore difesa
        </label>
        <label className="check">
          <input type="checkbox" name="capitano" defaultChecked={config.ruleset.captain.enabled} />
          Capitano
        </label>
      </fieldset>

      <div><Salva /></div>
    </form>
  );
}
