import Link from 'next/link';
import { notFound } from 'next/navigation';
import { store } from '@/lib/store';
import { requireAccount } from '@/lib/session';
import { edizioneLeggibile } from '@fantacomics/pipeline';
import { stagioneDi } from '@fantacomics/ingest';
import { prezzoLeggibile } from '@fantacomics/billing';
import {
  rigeneraLink, generaChiaveEstensione, revocaChiaveEstensione, approvaEdizione, generaVigilia,
  pagaLega,
} from '@/app/actions';
import { ConfigForm } from './config-form';

export const dynamic = 'force-dynamic';

export default async function Lega({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount();

  // Lega altrui e lega inesistente arrivano entrambe qui: lo store non
  // distingue i due casi, e nemmeno la pagina.
  const config = await store.getConfigForOwner(id, account.accountId);
  if (!config) notFound();

  // Le rose bastano a fare un numero di vigilia: se ci sono, si offre.
  const rose = await store.getRoster(id);
  const stagione = stagioneDi(new Date());
  const attiva = await store.getEntitlement(id, stagione);
  const refs = await store.listEditions(id);
  const editions = await Promise.all(
    refs.map(async ({ matchday: n, kind }) => {
      const published = await store.getEdition(id, n, kind);
      return {
        n,
        kind,
        vigilia: kind === 'anteprima',
        edition: published?.edition ?? null,
        leggibile: published ? edizioneLeggibile(published) : false,
        approvata: published?.approvedAt ?? null,
      };
    }),
  );

  const base = process.env.FANTACOMICS_URL ?? 'http://localhost:3000';
  const ultima = config.lastMatchday;

  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker"><Link href="/">FantaComics</Link> · Lega</p>
        <h1>{config.leagueName}</h1>
      </header>

      <h2>Stagione {stagione}</h2>
      {attiva ? (
        <>
          <p className="muted small">
            Lega attiva. Il giornale esce due volte a settimana: la mattina in cui
            si comincia a giocare e la mattina dopo l&rsquo;ultima partita.
          </p>
          {rose ? (
            <form action={generaVigilia} className="row">
              <input type="hidden" name="leagueId" value={config.leagueId} />
              <button className="btn" type="submit">
                Fai uscire il numero di vigilia (giornata {(config.lastMatchday ?? 0) + 1})
              </button>
            </form>
          ) : (
            <p className="muted small">
              Carica il file delle rose per far uscire il primo numero.
            </p>
          )}
        </>
      ) : (
        <>
          {/* Si mostra cosa e' gia' entrato PRIMA di chiedere i soldi: chi ha
              appena caricato il file vuole sapere che e' stato letto bene. */}
          {rose ? (
            <p className="muted small">
              Rose caricate: {rose.teams.length} squadre,{' '}
              {rose.teams.reduce((n, t) => n + t.players.length, 0)} giocatori.
            </p>
          ) : null}
          <p className="muted small">
            Questa lega non e&rsquo; ancora attiva per la stagione {stagione}. Si paga
            una volta sola, {prezzoLeggibile()} per lega: da quel momento il giornale
            esce due volte a settimana fino a fine stagione.
          </p>
          <form action={pagaLega} className="row">
            <input type="hidden" name="leagueId" value={config.leagueId} />
            <button className="btn btn--primary" type="submit">
              Attiva la lega — {prezzoLeggibile()}
            </button>
          </form>
        </>
      )}

      <h2>Edizioni</h2>
      {editions.length === 0 ? (
        <p className="muted">Nessuna edizione ancora pubblicata.</p>
      ) : (
        <ul className="card-list">
          {editions.map(({ n, kind, vigilia, edition, leggibile, approvata }) => (
            /* La chiave include il tipo: le due uscite della settimana hanno la
               stessa giornata, e con la sola giornata React ne mostrerebbe una. */
            <li key={`${n}-${kind}`} className="item">
              <span>
                <strong>{vigilia ? `Vigilia della giornata ${n}` : `Giornata ${n}`}</strong>
                <br />
                <span className="muted small">
                  {edition
                    ? `${edition.articles.length} pezzi · confidenza ${edition.meta.confidence.toFixed(2)}`
                    : '—'}
                  {edition?.meta.degraded ? ' · edizione ridotta' : ''}
                  {!leggibile ? ' · in revisione, non pubblica' : ''}
                  {approvata ? ' · approvata a mano' : ''}
                </span>
              </span>
              <span className="row">
                {leggibile ? (
                  <>
                    <Link
                      className="btn"
                      href={vigilia
                        ? `/g/${config.publicSlug}/${n}/vigilia`
                        : `/g/${config.publicSlug}/${n}`}
                    >
                      Leggi
                    </Link>
                    {!vigilia && edition?.personalCards[0] ? (
                      <Link
                        className="btn"
                        href={`/g/${config.publicSlug}/${n}/card/${edition.personalCards[0].teamId}`}
                      >
                        Card
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* L'anteprima passa dall'id interno e dalla sessione, non
                        dallo slug: chi ha il link condiviso non deve poter
                        aprire una bozza. */}
                    <Link
                      className="btn"
                      href={`/lega/${config.leagueId}/anteprima/${n}?tipo=${kind}`}
                    >
                      Rivedi
                    </Link>
                    <form action={approvaEdizione}>
                      <input type="hidden" name="leagueId" value={config.leagueId} />
                      <input type="hidden" name="matchday" value={n} />
                      <input type="hidden" name="tipo" value={kind} />
                      <button className="btn btn--primary" type="submit">
                        Pubblica lo stesso
                      </button>
                    </form>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Link da condividere</h2>
      <p className="muted small">
        Un&rsquo;edizione in revisione non risponde a questo indirizzo, nemmeno per
        chi ha gi&agrave; il link: sotto la soglia di confidenza il giornale non esce,
        e &laquo;meglio nessun giornale che un giornale sbagliato&raquo; deve valere anche
        quando &egrave; scomodo. La rivedi qui sopra e decidi tu.
      </p>
      <p className="muted small">
        Il giornale si legge senza account: è così che gira nel gruppo. L’indirizzo
        è un segreto lungo e separato dall’identità della lega, quindi se finisce
        dove non doveva puoi rigenerarlo e il vecchio smette di funzionare.
      </p>
      <div className="share-box">
        <code>{ultima ? `${base}/g/${config.publicSlug}/${ultima}` : `${base}/g/${config.publicSlug}/…`}</code>
        <form action={rigeneraLink}>
          <input type="hidden" name="leagueId" value={config.leagueId} />
          <button className="btn" type="submit">Rigenera il link (revoca il precedente)</button>
        </form>
      </div>

      <h2>Estensione del browser</h2>
      <p className="muted small">
        L’estensione legge i dati che la pagina della piattaforma ti ha già
        mostrato e li manda qui. Nessuna password viene custodita e il traffico
        resta il tuo, con i tuoi volumi: non è accesso automatizzato. Questa
        chiave dice all’estensione di quale lega sta parlando — è l’unica cosa
        che devi incollarci dentro.
      </p>
      {config.relaySecret ? (
        <div className="share-box">
          <code>{config.relaySecret}</code>
          <div className="row">
            <form action={generaChiaveEstensione}>
              <input type="hidden" name="leagueId" value={config.leagueId} />
              <button className="btn" type="submit">Ruota (revoca la precedente)</button>
            </form>
            <form action={revocaChiaveEstensione}>
              <input type="hidden" name="leagueId" value={config.leagueId} />
              <button className="btn" type="submit">Revoca</button>
            </form>
          </div>
        </div>
      ) : (
        <div className="share-box">
          <span className="muted small">
            Nessuna chiave attiva. Una credenziale che esiste prima di servire è
            una credenziale in giro senza motivo.
          </span>
          <form action={generaChiaveEstensione}>
            <input type="hidden" name="leagueId" value={config.leagueId} />
            <button className="btn btn--primary" type="submit">Genera la chiave</button>
          </form>
        </div>
      )}

      <h2>Regolamento</h2>
      <p className="muted small">
        Il regolamento è un dato, non un’assunzione: se non corrisponde a quello
        della tua lega i punteggi non riconcilieranno e le analisi si spegneranno
        da sole invece di raccontare numeri sbagliati.
      </p>
      <ConfigForm config={config} />

      <footer className="colophon-row">
        <span className="muted small">
          Regolamento versione {config.ruleset.version} · creata il{' '}
          {new Date(config.createdAt).toLocaleDateString('it-IT')}
        </span>
        <form action="/esci" method="post">
          <button className="btn" type="submit">Esci</button>
        </form>
      </footer>
    </main>
  );
}
