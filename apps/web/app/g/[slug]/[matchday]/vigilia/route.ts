import { serviGiornale } from '@/lib/edizione';

export const dynamic = 'force-dynamic';

/**
 * L'ANTEPRIMA: il numero della mattina in cui si comincia a giocare.
 *
 * Nell'indirizzo si chiama «vigilia» e non «anteprima» di proposito. Dentro
 * l'app «anteprima» significa gia' un'altra cosa — la revisione di una bozza
 * prima di pubblicarla, sotto `/lega/[id]/anteprima/[matchday]` — e due
 * significati per la stessa parola in due URL diversi e' il genere di
 * ambiguita' che costa mezz'ora a chi legge il codice fra sei mesi.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; matchday: string }> },
): Promise<Response> {
  const { slug, matchday } = await params;
  return serviGiornale(slug, matchday, 'anteprima');
}
