import { redirect } from 'next/navigation';
import { endSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Uscita.
 *
 * È una POST, non una GET: un logout raggiungibile con una GET si attiva da
 * un'immagine remota o da un prefetch, e butta fuori l'utente senza che abbia
 * cliccato niente.
 */
export async function POST(): Promise<Response> {
  await endSession();
  redirect('/accedi');
}
