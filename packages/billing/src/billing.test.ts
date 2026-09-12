import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verificaFirmaStripe, firmaComeStripe, TOLLERANZA_SECONDI,
  leggiEvento, creaSessioneCheckout, riferimento, ErroreStripe,
  PREZZO_CENTESIMI, VALUTA, prezzoLeggibile,
} from './index.js';

const SEGRETO = 'whsec_un_segreto_di_prova_abbastanza_lungo';
const CORPO = '{"id":"evt_1","type":"checkout.session.completed"}';
const ADESSO = 1_700_000_000;

describe('la firma del webhook', () => {
  it('accetta una firma valida', () => {
    const header = firmaComeStripe(CORPO, SEGRETO, ADESSO);
    expect(verificaFirmaStripe({ corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO }))
      .toEqual({ ok: true });
  });

  it('rifiuta un corpo cambiato di un solo carattere', () => {
    /**
     * E' l'attacco che conta: l'evento arriva da internet, e senza questo
     * controllo chiunque conosca l'indirizzo attiva le leghe che vuole.
     */
    const header = firmaComeStripe(CORPO, SEGRETO, ADESSO);
    const manomesso = CORPO.replace('evt_1', 'evt_2');
    const esito = verificaFirmaStripe({
      corpo: manomesso, header, segreto: SEGRETO, adessoSecondi: ADESSO,
    });
    expect(esito.ok).toBe(false);
  });

  it('rifiuta una firma fatta con un altro segreto', () => {
    const header = firmaComeStripe(CORPO, 'whsec_un_altro_segreto_lungo_uguale', ADESSO);
    expect(verificaFirmaStripe({
      corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO,
    }).ok).toBe(false);
  });

  it('rifiuta una firma vecchia: e\' il replay che nessuna firma ferma', () => {
    const header = firmaComeStripe(CORPO, SEGRETO, ADESSO);
    const esito = verificaFirmaStripe({
      corpo: CORPO, header, segreto: SEGRETO,
      adessoSecondi: ADESSO + TOLLERANZA_SECONDI + 1,
    });
    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.motivo).toContain('tolleranza');
  });

  it('rifiuta anche una firma NEL FUTURO', () => {
    /**
     * Controllare solo «troppo vecchia» lascerebbe passare un timestamp in
     * avanti, e un orologio sfasato dall'altro lato renderebbe una firma valida
     * per ore dopo la scadenza.
     */
    const header = firmaComeStripe(CORPO, SEGRETO, ADESSO + TOLLERANZA_SECONDI + 1);
    expect(verificaFirmaStripe({
      corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO,
    }).ok).toBe(false);
  });

  it('accetta quando UNA delle firme corrisponde: e\' la rotazione del segreto', () => {
    const buona = createHmac('sha256', SEGRETO).update(`${ADESSO}.${CORPO}`).digest('hex');
    const header = `t=${ADESSO},v1=${'0'.repeat(64)},v1=${buona}`;
    expect(verificaFirmaStripe({
      corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO,
    }).ok).toBe(true);
  });

  it('ignora le versioni sconosciute invece di fallire', () => {
    const buona = createHmac('sha256', SEGRETO).update(`${ADESSO}.${CORPO}`).digest('hex');
    const header = `t=${ADESSO},v0=qualcosa,v1=${buona}`;
    expect(verificaFirmaStripe({
      corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO,
    }).ok).toBe(true);
  });

  it('senza segreto configurato non passa niente', () => {
    const header = firmaComeStripe(CORPO, SEGRETO, ADESSO);
    // Il valore predefinito di una porta e' chiusa: un endpoint di pagamento
    // senza segreto deve rifiutare, non aprirsi.
    expect(verificaFirmaStripe({ corpo: CORPO, header, segreto: '' }).ok).toBe(false);
  });

  it('header malformati non fanno passare e non fanno esplodere', () => {
    for (const header of [
      '', 'ciao', 't=', 'v1=abc', `t=${ADESSO}`, `t=non-un-numero,v1=abc`,
      `t=${ADESSO},v1=`, `t=${ADESSO},v1=zz`, `t=${ADESSO},v1=${'a'.repeat(63)}`,
    ]) {
      const esito = verificaFirmaStripe({
        corpo: CORPO, header, segreto: SEGRETO, adessoSecondi: ADESSO,
      });
      expect(esito.ok, `header: "${header}"`).toBe(false);
    }
  });
});

describe('la lettura dell\'evento', () => {
  const sessione = (over: Record<string, unknown> = {}) => ({
    id: 'evt_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        amount_total: PREZZO_CENTESIMI,
        currency: VALUTA,
        client_reference_id: 'lega-abc:2025-26',
        customer_details: { email: 'mario@example.com' },
        ...over,
      },
    },
  });

  it('riconosce un pagamento e ne estrae lega e stagione', () => {
    const esito = leggiEvento(sessione());
    expect(esito.esito).toBe('pagamento');
    if (esito.esito === 'pagamento') {
      expect(esito.pagamento.leagueId).toBe('lega-abc');
      expect(esito.pagamento.season).toBe('2025-26');
      expect(esito.pagamento.eventId).toBe('evt_123');
      expect(esito.pagamento.email).toBe('mario@example.com');
    }
  });

  it('un id di lega che contiene i due punti resta intero', () => {
    // Si taglia sull'ULTIMO due punti: gli id li generiamo noi, ma un giorno
    // potrebbero contenerne, e spezzare sul primo darebbe una lega sbagliata.
    const esito = leggiEvento(sessione({ client_reference_id: 'lega:strana:2025-26' }));
    expect(esito.esito).toBe('pagamento');
    if (esito.esito === 'pagamento') expect(esito.pagamento.leagueId).toBe('lega:strana');
  });

  it('IGNORA gli eventi che non ci riguardano, senza rifiutarli', () => {
    /**
     * Stripe manda decine di tipi di evento. Rifiutarli farebbe ritentare
     * all'infinito e alla fine disattiverebbe l'endpoint: ignorare e' la
     * risposta giusta, ed e' diversa da rifiutare.
     */
    const esito = leggiEvento({ ...sessione(), type: 'invoice.paid' });
    expect(esito.esito).toBe('ignorato');
  });

  it('ignora una sessione completata ma NON pagata', () => {
    expect(leggiEvento(sessione({ payment_status: 'unpaid' })).esito).toBe('ignorato');
  });

  it('RIFIUTA un importo diverso da quello atteso', () => {
    /**
     * Non e' una difesa contro un attaccante — senza la nostra chiave nessuno
     * crea sessioni — e' una difesa contro noi stessi: un prezzo cambiato in un
     * posto e non nell'altro attiverebbe leghe per l'importo sbagliato senza
     * che nessuno se ne accorga.
     */
    const esito = leggiEvento(sessione({ amount_total: 1 }));
    expect(esito.esito).toBe('rifiutato');
    if (esito.esito === 'rifiutato') expect(esito.motivo).toContain('Importo');
  });

  it('rifiuta una valuta diversa', () => {
    expect(leggiEvento(sessione({ currency: 'usd' })).esito).toBe('rifiutato');
  });

  it('rifiuta un evento senza riferimento alla lega', () => {
    expect(leggiEvento(sessione({ client_reference_id: null })).esito).toBe('rifiutato');
  });

  it('rifiuta una stagione che non ha la forma di una stagione', () => {
    expect(leggiEvento(sessione({ client_reference_id: 'lega-abc:boh' })).esito).toBe('rifiutato');
  });

  it('ripiega sui metadata quando il riferimento manca', () => {
    const esito = leggiEvento(sessione({
      client_reference_id: null,
      metadata: { leagueId: 'lega-xyz', season: '2025-26' },
    }));
    expect(esito.esito).toBe('pagamento');
  });

  it('un corpo che non ha la forma di un evento viene rifiutato, non letto a fiducia', () => {
    for (const grezzo of [null, 42, {}, { type: 'checkout.session.completed' }]) {
      expect(leggiEvento(grezzo).esito).toBe('rifiutato');
    }
  });
});

describe('la creazione della sessione di pagamento', () => {
  function finto(risposta: { stato: number; corpo: unknown }) {
    const visto: { url: string; corpo: string; headers: Record<string, string> }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      visto.push({
        url: String(url),
        corpo: String(init?.body ?? ''),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify(risposta.corpo), { status: risposta.stato });
    }) as unknown as typeof fetch;
    return { impl, visto };
  }

  const richiesta = {
    leagueId: 'lega-abc', leagueName: 'Lega Uno', season: '2025-26',
    successUrl: 'https://esempio.it/ok', cancelUrl: 'https://esempio.it/no',
  };

  it('manda l\'importo deciso dal SERVER, non uno ricevuto da fuori', async () => {
    const { impl, visto } = finto({
      stato: 200, corpo: { id: 'cs_1', url: 'https://checkout/x' },
    });
    await creaSessioneCheckout(
      { chiave: 'sk_test', baseUrl: 'https://finto', fetchImpl: impl }, richiesta,
    );
    const corpo = new URLSearchParams(visto[0]?.corpo ?? '');
    expect(corpo.get('line_items[0][price_data][unit_amount]')).toBe(String(PREZZO_CENTESIMI));
    expect(corpo.get('line_items[0][price_data][currency]')).toBe(VALUTA);
    expect(corpo.get('mode')).toBe('payment');
    expect(corpo.get('client_reference_id')).toBe(riferimento('lega-abc', '2025-26'));
  });

  it('e\' idempotente su (lega, stagione): due clic non fanno due pagamenti', async () => {
    const { impl, visto } = finto({
      stato: 200, corpo: { id: 'cs_1', url: 'https://checkout/x' },
    });
    const opz = { chiave: 'sk_test', baseUrl: 'https://finto', fetchImpl: impl };
    await creaSessioneCheckout(opz, richiesta);
    await creaSessioneCheckout(opz, richiesta);
    const chiavi = visto.map((v) => v.headers['idempotency-key']);
    expect(chiavi[0]).toBe(chiavi[1]);
    expect(chiavi[0]).toContain('lega-abc:2025-26');
  });

  it('la chiave viaggia nell\'header, mai nel corpo', async () => {
    const { impl, visto } = finto({
      stato: 200, corpo: { id: 'cs_1', url: 'https://checkout/x' },
    });
    await creaSessioneCheckout(
      { chiave: 'sk_test_segretissima', baseUrl: 'https://finto', fetchImpl: impl }, richiesta,
    );
    expect(visto[0]?.headers.authorization).toBe('Bearer sk_test_segretissima');
    expect(visto[0]?.corpo).not.toContain('sk_test_segretissima');
  });

  it('un rifiuto di Stripe diventa un errore che non ripete la chiave', async () => {
    const { impl } = finto({
      stato: 401,
      corpo: { error: { message: 'Invalid API Key provided: sk_test_segretissima' } },
    });
    await expect(creaSessioneCheckout(
      { chiave: 'sk_test_segretissima', baseUrl: 'https://finto', fetchImpl: impl }, richiesta,
    )).rejects.toThrow(ErroreStripe);

    try {
      await creaSessioneCheckout(
        { chiave: 'sk_test_segretissima', baseUrl: 'https://finto', fetchImpl: impl }, richiesta,
      );
    } catch (e) {
      // Il messaggio di Stripe puo' contenere la chiave: non si ricopia.
      expect((e as Error).message).not.toContain('sk_test_segretissima');
    }
  });

  it('una risposta senza url e\' un errore, non una sessione a meta\'', async () => {
    const { impl } = finto({ stato: 200, corpo: { id: 'cs_1' } });
    await expect(creaSessioneCheckout(
      { chiave: 'sk', baseUrl: 'https://finto', fetchImpl: impl }, richiesta,
    )).rejects.toThrow(ErroreStripe);
  });
});

describe('il prezzo', () => {
  it('e\' 4,99 euro una tantum', () => {
    expect(PREZZO_CENTESIMI).toBe(499);
    expect(VALUTA).toBe('eur');
    expect(prezzoLeggibile()).toBe('4,99 €');
  });

  it('sta in centesimi: i soldi in virgola mobile perdono un centesimo ogni tanto', () => {
    expect(Number.isInteger(PREZZO_CENTESIMI)).toBe(true);
  });
});
