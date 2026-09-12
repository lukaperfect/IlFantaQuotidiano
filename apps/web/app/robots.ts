import type { MetadataRoute } from 'next';

/**
 * COSA DIRE AI MOTORI DI RICERCA, E PERCHE' NON BASTA UN DISALLOW.
 *
 * Il giornale sta a un indirizzo segreto e revocabile. La tentazione e'
 * scrivere `Disallow: /g/` e sentirsi a posto — ed e' la mossa sbagliata:
 * `Disallow` impedisce di SCARICARE la pagina, non di indicizzarla. Un motore
 * che trova il link altrove (un messaggio pubblico, un forum) puo' elencare
 * l'URL lo stesso, e per di piu' non scaricandolo non vedra' mai il
 * `noindex` che gli stiamo dicendo di rispettare.
 *
 * La combinazione che funziona e' l'opposto: lasciar scaricare `/g/`, e
 * servire su ogni risposta un `X-Robots-Tag: noindex`. Il motore legge
 * l'istruzione e non indicizza.
 *
 * Qui si vieta solo cio' che non ha senso scaricare: l'API e le pagine dietro
 * sessione, che a un visitatore anonimo rispondono comunque con un
 * reindirizzamento o un 404.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        // `/g/` NON e' vietato di proposito: dev'essere scaricabile perche'
        // il `noindex` nell'header venga letto.
        disallow: ['/api/', '/lega/', '/accedi/'],
        allow: '/',
      },
    ],
  };
}
