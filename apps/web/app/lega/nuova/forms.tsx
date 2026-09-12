'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  creaLegaDaFile, creaLegaDaRose, creaLegaDiProva, type EsitoCreazione,
} from '@/app/actions';

/**
 * Un pulsante che dice di stare lavorando.
 *
 * Generare un giornale richiede secondi, non millisecondi: senza questo,
 * l'utente preme di nuovo, e la seconda pressione parte davvero.
 */
function Invia({ testo, attesa, primario = true }: {
  testo: string; attesa: string; primario?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={primario ? 'btn btn--primary' : 'btn'} type="submit" disabled={pending}>
      {pending ? attesa : testo}
    </button>
  );
}

function Esito({ esito }: { esito: EsitoCreazione | null }) {
  if (!esito || esito.ok) return null;
  // Il messaggio arriva dall'importatore ed e' specifico: quale file, quale
  // riga, cosa manca. E' l'unica informazione che rende l'errore risolvibile.
  return <p className="notice error" role="status">{esito.messaggio}</p>;
}

/**
 * Il caricamento delle rose dal file della piattaforma.
 *
 * Sta PRIMA dei CSV nella pagina perche' per chi ha una lega vera e' il
 * percorso piu' corto: il file esiste gia', non va costruito.
 */
export function FormRose() {
  const [esito, azione] = useActionState<EsitoCreazione | null, FormData>(creaLegaDaRose, null);
  return (
    <form action={azione} data-modulo="rose-xlsx">
      <Esito esito={esito} />
      <label>
        Nome della lega
        <input name="leagueName" maxLength={60} required placeholder="La mia lega" />
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>
          Stagione
          <input name="season" defaultValue="2025-26" pattern="[0-9]{4}-[0-9]{2}" required />
        </label>
        <label style={{ flex: 1 }}>
          Piccante
          <select name="spice" defaultValue="2">
            <option value="1">Bonario</option>
            <option value="2">Pungente</option>
            <option value="3">Feroce</option>
          </select>
        </label>
      </div>
      <label>
        Foglio delle rose (.xlsx)
        <input name="roseXlsx" type="file" accept=".xlsx" required />
      </label>
      <Invia testo="Carica le rose" attesa="Leggo il file…" />
    </form>
  );
}

export function FormProva() {
  const [esito, azione] = useActionState<EsitoCreazione | null, FormData>(creaLegaDiProva, null);
  return (
    <form action={azione}>
      <Esito esito={esito} />
      <label>
        Nome della lega
        <input name="leagueName" defaultValue="Lega di prova" maxLength={60} required />
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>
          Squadre
          <input name="teams" type="number" min={4} max={12} step={2} defaultValue={8} />
        </label>
        <label style={{ flex: 1 }}>
          Livello di piccante
          <select name="spice" defaultValue="2">
            <option value="1">1 · bonario</option>
            <option value="2">2 · standard</option>
            <option value="3">3 · pungente</option>
          </select>
        </label>
      </div>
      <div><Invia testo="Genera la lega di prova" attesa="Genero tre giornate…" /></div>
    </form>
  );
}

export function FormFile({ teste }: { teste: Record<string, string> }) {
  const [esito, azione] = useActionState<EsitoCreazione | null, FormData>(creaLegaDaFile, null);
  return (
    <form action={azione}>
      <Esito esito={esito} />
      <label>
        Nome della lega
        <input name="leagueName" maxLength={60} required />
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>
          Stagione
          <input name="season" defaultValue="2025-26" required />
        </label>
        <label style={{ flex: 1 }}>
          Giornata
          <input name="matchday" type="number" min={1} max={38} defaultValue={1} required />
        </label>
        <label style={{ flex: 1 }}>
          Piccante
          <select name="spice" defaultValue="2">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
      </div>

      <p className="muted small">
        Non devi indovinare le colonne: ogni file ha un modello scaricabile,
        generato dallo stesso codice che poi lo rilegge. Aprilo, sostituisci le
        righe con le tue e ricaricalo.
      </p>

      <fieldset>
        <legend>File obbligatori</legend>
        {(['voti', 'formazioni', 'calendario'] as const).map((nome) => (
          <label key={nome}>
            {nome}.csv{' '}
            <a className="hint" href={`/modelli/${nome}.csv`} download>scarica il modello</a>
            <code className="colonne">{teste[nome]}</code>
            <input name={nome} type="file" accept=".csv,text/csv" required />
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Facoltativi — sbloccano altri fatti</legend>
        <label>
          rose.csv <span className="hint">sblocca il flop d’asta</span>{' '}
          <a className="hint" href="/modelli/rose.csv" download>scarica il modello</a>
          <code className="colonne">{teste.rose}</code>
          <input name="rose" type="file" accept=".csv,text/csv" />
        </label>
        <label>
          classifica.csv <span className="hint">sblocca sorpassi e nuovo leader</span>{' '}
          <a className="hint" href="/modelli/classifica.csv" download>scarica il modello</a>
          <code className="colonne">{teste.classifica}</code>
          <input name="classifica" type="file" accept=".csv,text/csv" />
        </label>
      </fieldset>

      <div><Invia testo="Importa e genera" attesa="Importo e genero…" primario={false} /></div>
    </form>
  );
}
