import Link from 'next/link';
import type { Metadata } from 'next';
import { titolare, fornitoreModello } from '@/lib/titolare';

export const metadata: Metadata = { title: 'Privacy · FantaComics' };
export const dynamic = 'force-dynamic';

/**
 * INFORMATIVA PRIVACY.
 *
 * Bozza di lavoro, e la pagina lo dice finche' i dati del titolare mancano.
 *
 * IL PUNTO CHE CONTA DAVVERO, e che un'informativa copiata da un modello non
 * avrebbe: i NOMI DEI PRESIDENTI della lega finiscono nel testo del giornale,
 * e con una chiave vera passano dal fornitore del modello. Sono dati personali
 * di persone che non hanno un account qui — le carica l'amministratore della
 * lega — e l'unico modo onesto di trattarli e' dirlo, dire a chi vanno, e dire
 * come si fanno togliere.
 */
export default function Privacy() {
  const t = titolare();
  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker">Dati personali</p>
        <h1>Informativa privacy</h1>
      </header>

      {t === null && (
        <p className="notice error">
          <strong>Bozza incompleta.</strong> Manca il titolare del trattamento
          (<code>FANTACOMICS_TITOLARE</code>, <code>FANTACOMICS_PIVA</code>,{' '}
          <code>FANTACOMICS_INDIRIZZO</code>, <code>FANTACOMICS_EMAIL_CONTATTO</code>).
          Un&rsquo;informativa senza titolare non e&rsquo; un&rsquo;informativa.
        </p>
      )}

      <h2>Titolare del trattamento</h2>
      <p>
        {t
          ? <>{t.nome}, P. IVA {t.piva}, {t.indirizzo}. Per esercitare i propri diritti: {t.email}.</>
          : <span className="muted">[da configurare]</span>}
      </p>

      <h2>Quali dati, e perche&rsquo;</h2>
      <ul className="card-list">
        <li className="item">
          <strong>Indirizzo email.</strong> Serve ad accedere: non ci sono password, si
          entra da un collegamento monouso spedito via mail. Base giuridica:
          esecuzione del contratto.
        </li>
        <li className="item">
          <strong>I dati della lega</strong> caricati dall&rsquo;amministratore: nomi
          delle squadre, <strong>nomi dei presidenti</strong>, rose, formazioni,
          punteggi. Servono a produrre il giornale. Base giuridica: esecuzione del
          contratto con chi li carica.
        </li>
        <li className="item">
          <strong>Dati di pagamento.</strong> Li tratta Stripe. Qui non arrivano ne&rsquo;
          il numero della carta ne&rsquo; altro: resta solo il fatto che una lega e&rsquo;
          attiva per una stagione.
        </li>
      </ul>

      <h2>A chi vengono comunicati</h2>
      <ul className="card-list">
        <li className="item">
          <strong>Fornitore del modello linguistico:</strong> {fornitoreModello()}. I
          fatti della giornata — compresi i nomi delle squadre e dei presidenti —
          vengono inviati per far scrivere i pezzi. Non vengono inviate le email degli
          utenti.
        </li>
        <li className="item"><strong>Stripe</strong>, per il pagamento.</li>
        <li className="item"><strong>Il fornitore di posta</strong> configurato, per i collegamenti di accesso.</li>
        <li className="item"><strong>L&rsquo;hosting</strong> e il database, che custodiscono i dati.</li>
      </ul>

      <h2>Il giornale e&rsquo; pubblico</h2>
      <p>
        Il giornale si legge senza account, da un indirizzo lungo e casuale: chi ha il
        collegamento legge, chi non ce l&rsquo;ha no. E&rsquo; una scelta del prodotto —
        serve a poterlo condividere nel gruppo — e significa che i nomi dei presidenti
        sono visibili a chi riceve quel collegamento. L&rsquo;amministratore puo&rsquo;
        rigenerarlo in un secondo: il vecchio smette di funzionare subito.
      </p>

      <h2>Per quanto tempo</h2>
      <p>
        I giornali e i dati della lega restano finche&rsquo; l&rsquo;amministratore non
        chiede di cancellarli, e comunque non oltre la fine della stagione successiva a
        quella pagata. I collegamenti di accesso scadono in quindici minuti e valgono
        una volta sola.
      </p>

      <h2>Diritti</h2>
      <p>
        Accesso, rettifica, cancellazione, limitazione, portabilita&rsquo; e opposizione,
        scrivendo al contatto qui sopra. Chi compare come presidente in una lega senza
        avere un account puo&rsquo; chiedere la cancellazione del proprio nome: si scrive
        allo stesso indirizzo. Resta il diritto di reclamo al Garante per la protezione
        dei dati personali.
      </p>

      <h2>Cookie</h2>
      <p>
        Solo tecnici: il cookie di sessione di chi ha effettuato l&rsquo;accesso e quello
        che lega un collegamento di accesso al browser che lo ha chiesto. Nessun cookie
        di profilazione e nessuna statistica di terze parti.
      </p>

      <p className="colophon-row">
        <Link href="/termini">Termini di servizio</Link> · <Link href="/">Torna al sito</Link>
      </p>
    </main>
  );
}
