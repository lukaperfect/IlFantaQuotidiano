/**
 * IL PREZZO, IN UN POSTO SOLO.
 *
 * 4,99 euro una tantum per lega e per stagione. Non e' un abbonamento: chi
 * gioca al fantacalcio paga l'iscrizione alla lega una volta all'anno, e un
 * addebito mensile per un prodotto che vive da settembre a maggio e' una
 * disdetta annunciata.
 *
 * Sta in centesimi perche' i soldi in virgola mobile sono un modo di perdere
 * un centesimo ogni tanto, e sta qui perche' il prezzo NON deve mai arrivare
 * dal client: un importo che il browser puo' scegliere e' un prodotto gratis
 * per chi sa aprire gli strumenti per sviluppatori.
 */
export const PREZZO_CENTESIMI = 499;
export const VALUTA = 'eur';

/** Quanto costa una lega per una stagione, come lo si scrive in pagina. */
export function prezzoLeggibile(): string {
  return `${(PREZZO_CENTESIMI / 100).toFixed(2).replace('.', ',')} €`;
}
