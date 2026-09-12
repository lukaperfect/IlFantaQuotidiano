import Link from 'next/link';

/**
 * I collegamenti alle pagine legali.
 *
 * Stanno in un componente perche' devono comparire in PIU' punti — prima
 * dell'accesso e dopo — e perche' «raggiungibili prima dell'acquisto» e' un
 * requisito, non una cortesia: due copie a mano diventerebbero una copia sola
 * il giorno in cui qualcuno rifa' una delle due pagine.
 */
export function Legale() {
  return (
    <p className="muted small">
      <Link href="/termini">Termini di servizio</Link>
      {' · '}
      <Link href="/privacy">Privacy</Link>
    </p>
  );
}
