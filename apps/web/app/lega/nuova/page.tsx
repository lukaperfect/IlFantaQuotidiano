import Link from 'next/link';
import { requireAccount } from '@/lib/session';
import { intestazioni } from '@/lib/modelli';
import { FormProva, FormFile } from './forms';

export const dynamic = 'force-dynamic';

export default async function NuovaLega() {
  await requireAccount();
  // Le intestazioni escono dallo stesso esportatore dei modelli: cio' che si
  // legge in pagina e' cio' che l'importatore accetta, per costruzione.
  const teste = intestazioni();

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
        <FormProva />
      </section>

      <section>
        <h2>Oppure carica i tuoi dati</h2>
        <p className="muted small">
          Import da CSV: la via che funziona sempre, indipendente da qualunque
          piattaforma. I primi tre file sono obbligatori.
        </p>
        <FormFile teste={teste} />
      </section>
    </main>
  );
}
