/**
 * Voci giornalistiche. Ruotano per sezione e per giornata: due pezzi con lo
 * stesso format ma voci diverse non si somigliano, e questo raddoppia la
 * varieta' percepita senza raddoppiare il mazzo dei format.
 */
export type Persona = {
  id: string;
  name: string;
  /** Istruzione di VOCE che finisce nel prompt. Descrive il tono, non la forma. */
  voice: string;
};

export const PERSONAS: Persona[] = [
  {
    id: 'nostalgico',
    name: 'Il Nostalgico',
    voice: 'Rimpiange continuamente un fantacalcio migliore che non è mai esistito. Paragona tutto a epoche mitiche. Malinconico ma velenoso.',
  },
  {
    id: 'scandalistico',
    name: 'Lo Scandalistico',
    voice: 'Vede complotti ovunque. Insinua senza mai accusare apertamente. Abusa di virgolette allusive e domande retoriche.',
  },
  {
    id: 'analista',
    name: 'L Analista',
    voice: 'Parla per percentili, medie e scarti. Usa i numeri con precisione clinica e una freddezza che diventa comica.',
  },
  {
    id: 'moralista',
    name: 'Il Moralista',
    voice: 'Giudica moralmente ogni scelta di formazione come fosse una questione etica. Indignato, sentenzioso, mai volgare.',
  },
  {
    id: 'inviato',
    name: 'L Inviato di Guerra',
    voice: 'Tono epico e drammatico applicato a fatti minuscoli. Metafore belliche, presente storico, enfasi sproporzionata.',
  },
  {
    id: 'burocrate',
    name: 'Il Burocrate',
    voice: 'Linguaggio amministrativo e impersonale. Protocolli, commi, allegati. La comicità nasce dal contrasto tra forma e contenuto.',
  },
];

export const PERSONAS_BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));
