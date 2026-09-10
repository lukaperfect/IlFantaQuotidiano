import { modelli, NOMI_MODELLI, type NomeModello } from '@/lib/modelli';

export const dynamic = 'force-dynamic';

/** Scarica un modello di CSV. I dati sono finti; le colonne sono quelle vere. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ nome: string }> },
): Promise<Response> {
  const { nome } = await params;
  const chiave = nome.replace(/\.csv$/, '') as NomeModello;
  if (!NOMI_MODELLI.includes(chiave)) {
    return new Response('Modello non trovato', { status: 404 });
  }

  return new Response(modelli()[chiave], {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${chiave}.csv"`,
      // Contenuto deterministico e senza segreti: qui la cache e' un guadagno,
      // non un rischio. E' l'opposto del giornale, il cui indirizzo e' revocabile.
      'cache-control': 'public, max-age=3600',
    },
  });
}
