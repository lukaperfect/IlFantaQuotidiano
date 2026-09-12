import Link from 'next/link';
import type { Metadata } from 'next';
import { titolare } from '@/lib/titolare';
import { prezzoLeggibile } from '@fantacomics/billing';

export const metadata: Metadata = { title: 'Termini di servizio · FantaComics' };
export const dynamic = 'force-dynamic';

/**
 * TERMINI DI SERVIZIO.
 *
 * Sono una BOZZA DI LAVORO, e la pagina lo dice da sola finche' i dati del
 * titolare non sono configurati. Non e' prudenza formale: dei termini con
 * dentro un segnaposto sembrano validi a chi li legge di sfuggita, ed e'
 * esattamente il momento in cui non lo sono.
 *
 * Due punti vanno guardati da chi pubblica, perche' non sono scelte tecniche:
 *
 * 1. IL RECESSO. Un contenuto digitale consegnato subito fa perdere al
 *    consumatore i quattordici giorni di ripensamento, ma SOLO se lo ha
 *    accettato espressamente prima dell'acquisto. Quell'accettazione va
 *    raccolta nel checkout: senza, il diritto resta, e resta per quattordici
 *    giorni su un prodotto gia' consegnato.
 * 2. IL TRATTAMENTO DEI NOMI. I nomi dei presidenti della lega finiscono nel
 *    testo del giornale, e con una chiave vera passano dal fornitore del
 *    modello. E' scritto nella privacy, e va confermato che sia cio' che si
 *    intende fare.
 */
export default function Termini() {
  const t = titolare();
  return (
    <main className="wrap">
      <header className="top">
        <p className="kicker">Condizioni</p>
        <h1>Termini di servizio</h1>
      </header>

      {t === null && (
        <p className="notice error">
          <strong>Bozza incompleta.</strong> I dati del titolare non sono configurati
          (<code>FANTACOMICS_TITOLARE</code>, <code>FANTACOMICS_PIVA</code>,{' '}
          <code>FANTACOMICS_INDIRIZZO</code>, <code>FANTACOMICS_EMAIL_CONTATTO</code>).
          Questo testo non e&rsquo; utilizzabile finche&rsquo; non sono compilati e
          finche&rsquo; non li ha guardati un legale.
        </p>
      )}

      <h2>1. Chi eroga il servizio</h2>
      <p>
        {t
          ? <>{t.nome}, P. IVA {t.piva}, {t.indirizzo}. Contatti: {t.email}.</>
          : <span className="muted">[titolare, partita IVA, sede e contatto da configurare]</span>}
      </p>

      <h2>2. Che cosa e&rsquo; FantaComics</h2>
      <p>
        Un servizio che genera automaticamente un giornale satirico per una lega di
        fantacalcio, a partire dai dati della lega caricati dall&rsquo;utente e dai voti
        pubblicati da testate terze. Esce due volte a settimana durante la stagione di
        Serie A: la mattina del giorno in cui comincia la giornata e la mattina dopo
        l&rsquo;ultima partita.
      </p>
      <p>
        <strong>I testi sono satirici e generati automaticamente.</strong> Non sono
        giornalismo, non sono opinioni del titolare e possono contenere errori. I numeri
        sono ricalcolati e confrontati con quelli ufficiali, e un&rsquo;edizione che non
        quadra non viene pubblicata; il testo intorno ai numeri resta un prodotto
        automatico.
      </p>

      <h2>3. Prezzo</h2>
      <p>
        {prezzoLeggibile()} <strong>una tantum per lega e per stagione</strong>, IVA
        inclusa. Non e&rsquo; un abbonamento: non si rinnova e non c&rsquo;e&rsquo; niente da
        disdire. Il pagamento e&rsquo; gestito da Stripe; il titolare non tratta ne&rsquo;
        conserva i dati della carta.
      </p>

      <h2>4. Recesso</h2>
      <p>
        Si tratta di contenuto digitale fornito senza supporto materiale. Chiedendo
        l&rsquo;attivazione immediata della lega, l&rsquo;utente accetta espressamente che
        l&rsquo;esecuzione cominci subito e prende atto di perdere il diritto di recesso
        di quattordici giorni a esecuzione completata.
      </p>
      <p className="muted small">
        Questa clausola vale solo se quell&rsquo;accettazione viene raccolta prima del
        pagamento. Se non lo e&rsquo;, il diritto di recesso resta.
      </p>

      <h2>5. Obblighi dell&rsquo;utente</h2>
      <p>
        L&rsquo;utente carica i dati della propria lega e dichiara di avere titolo per
        farlo. Non e&rsquo; consentito usare il servizio per contenuti diffamatori verso
        persone che non fanno parte della lega, ne&rsquo; ridistribuire i giornali come
        prodotto proprio.
      </p>

      <h2>6. Disponibilita&rsquo; e limiti</h2>
      <p>
        Il servizio dipende da fonti terze per i voti di Serie A. Se una fonte diventa
        irraggiungibile o cambia, un&rsquo;edizione puo&rsquo; uscire in ritardo o non
        uscire: resta disponibile il caricamento manuale dei dati. Il titolare non
        risponde dei ritardi dovuti a terzi.
      </p>

      <h2>7. Chiusura</h2>
      <p>
        L&rsquo;utente puo&rsquo; smettere di usare il servizio quando vuole. Le leghe gia&rsquo;
        pagate restano leggibili fino alla fine della stagione pagata.
      </p>

      <p className="colophon-row">
        <Link href="/privacy">Informativa privacy</Link> · <Link href="/">Torna al sito</Link>
      </p>
    </main>
  );
}
