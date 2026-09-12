import { serviGiornale } from '@/lib/edizione';

export const dynamic = 'force-dynamic';

/**
 * Il giornale servito come DOCUMENTO completo, non come pagina React.
 *
 * È già un documento autonomo con la sua tipografia: farlo passare da un
 * layout applicativo significherebbe duplicare gli stili e farli divergere.
 * L'app è il piano di controllo; il giornale è il prodotto.
 *
 * Questo indirizzo è il RETROSPETTIVO, il numero della mattina dopo l'ultima
 * partita. Resta invariato: i link già girati nei gruppi continuano a valere.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; matchday: string }> },
): Promise<Response> {
  const { slug, matchday } = await params;
  return serviGiornale(slug, matchday, 'giornale');
}
