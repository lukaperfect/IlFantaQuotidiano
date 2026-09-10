import Link from 'next/link';
import { creaLegaDaFile, creaLegaDiProva } from '@/app/actions';
import { requireAccount } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function NuovaLega() {
  await requireAccount();
  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker"><Link href="/">FantaComics</Link> · Nuova lega</p>
        <h1>Collega una lega</h1>
      </header>

      <section>
        <h2>Provala subito</h2>
        <p className="muted small">
          Genera una lega con tre giornate di dati realistici. Serve a vedere il
          prodotto prima di mettersi a esportare file.
        </p>
        <form action={creaLegaDiProva}>
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
          <div><button className="btn btn--primary" type="submit">Genera la lega di prova</button></div>
        </form>
      </section>

      <section>
        <h2>Oppure carica i tuoi dati</h2>
        <p className="muted small">
          Import da CSV: la via che funziona sempre, indipendente da qualunque
          piattaforma. I primi tre file sono obbligatori.
        </p>
        <form action={creaLegaDaFile}>
          <label>
            Nome della lega
            <input name="leagueName" maxLength={60} required />
          </label>
          <div className="row">
            <label style={{ flex: 1 }}>
              Stagione
              <input name="season" defaultValue="2025-26" pattern="\d{4}-\d{2}" required />
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

          <fieldset>
            <legend>File obbligatori</legend>
            <label>voti.csv <input name="voti" type="file" accept=".csv,text/csv" required /></label>
            <label>formazioni.csv <input name="formazioni" type="file" accept=".csv,text/csv" required /></label>
            <label>calendario.csv <input name="calendario" type="file" accept=".csv,text/csv" required /></label>
          </fieldset>

          <fieldset>
            <legend>Facoltativi — sbloccano altri fatti</legend>
            <label>rose.csv <span className="hint">sblocca il flop d’asta</span>
              <input name="rose" type="file" accept=".csv,text/csv" /></label>
            <label>classifica.csv <span className="hint">sblocca sorpassi e nuovo leader</span>
              <input name="classifica" type="file" accept=".csv,text/csv" /></label>
          </fieldset>

          <div><button className="btn" type="submit">Importa e genera</button></div>
        </form>
      </section>
    </main>
  );
}
