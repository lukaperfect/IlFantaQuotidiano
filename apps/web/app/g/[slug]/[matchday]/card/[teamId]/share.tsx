'use client';

import { useState } from 'react';

/**
 * Condivisione a un tap.
 *
 * WhatsApp non permette a un bot di scrivere nei gruppi: qualsiasi piano che
 * lo assuma è irrealizzabile. La condivisione resta quindi un gesto
 * dell'utente, e il compito del prodotto è renderlo di un tap solo.
 */
export function ShareButton({ title, text }: { title: string; text: string }) {
  const [copiato, setCopiato] = useState(false);

  const condividi = async (): Promise<void> => {
    const url = typeof window === 'undefined' ? '' : window.location.href;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch {
        // L'utente ha annullato, oppure il browser ha rifiutato: si ripiega.
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setCopiato(true);
      setTimeout(() => setCopiato(false), 2500);
    } catch {
      window.prompt('Copia il link', url);
    }
  };

  return (
    <button className="btn btn--primary" type="button" onClick={condividi}>
      {copiato ? 'Link copiato' : 'Condividi'}
    </button>
  );
}
