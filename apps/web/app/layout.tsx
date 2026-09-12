import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * `metadataBase` non e' un dettaglio: senza, Next emette l'URL dell'immagine
 * OG in forma relativa e nessun client di messaggistica riesce a risolverla.
 * L'anteprima nel gruppo e' cio' che genera il click, quindi un OG rotto
 * disattiva in silenzio la feature che moltiplica la condivisione.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.FANTACOMICS_URL ?? 'http://localhost:3000'),
  title: 'FantaComics',
  description: 'Il giornale della tua lega di fantacalcio, ogni giornata.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
