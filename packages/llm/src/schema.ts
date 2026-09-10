/**
 * Structured outputs: lo schema che il modello DEVE rispettare.
 *
 * L'LLM non produce HTML. Produce blocchi tipizzati con vincoli di lunghezza,
 * e il renderer li mappa negli slot di impaginazione. Cosi' un solo contenuto
 * alimenta web, PDF e card social, e un titolo di 70 caratteri non rompe la
 * prima pagina perche' non puo' proprio essere generato.
 */

type JsonSchema = Record<string, unknown>;

const text = (min: number, max: number): JsonSchema => ({
  type: 'string', minLength: min, maxLength: max,
});

const BLOCK_SCHEMAS: Record<string, JsonSchema> = {
  headline: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'text'],
    properties: { kind: { const: 'headline' }, text: text(8, 62) },
  },
  standfirst: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'text'],
    properties: { kind: { const: 'standfirst' }, text: text(20, 180) },
  },
  body: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'paragraphs'],
    properties: {
      kind: { const: 'body' },
      paragraphs: { type: 'array', minItems: 1, maxItems: 8, items: text(40, 700) },
    },
  },
  pull_quote: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'text', 'attribution'],
    properties: {
      kind: { const: 'pull_quote' }, text: text(10, 160),
      attribution: { type: 'string', maxLength: 60 },
    },
  },
  interview: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'intro', 'qa'],
    properties: {
      kind: { const: 'interview' },
      intro: { type: 'string', maxLength: 300 },
      qa: {
        type: 'array', minItems: 2, maxItems: 8,
        items: {
          type: 'object', additionalProperties: false,
          required: ['q', 'a'],
          properties: { q: text(5, 220), a: text(5, 500) },
        },
      },
    },
  },
  pagella: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'rows'],
    properties: {
      kind: { const: 'pagella' },
      rows: {
        type: 'array', minItems: 2, maxItems: 12,
        items: {
          type: 'object', additionalProperties: false,
          required: ['subject', 'vote', 'note'],
          properties: { subject: text(1, 40), vote: text(1, 6), note: text(5, 180) },
        },
      },
    },
  },
  boxscore: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'factId', 'caption'],
    properties: {
      kind: { const: 'boxscore' },
      // Referenzia un fatto per id: i numeri li mette il renderer, non il modello.
      factId: { type: 'string', minLength: 1 },
      caption: { type: 'string', maxLength: 120 },
    },
  },
  list: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'title', 'items'],
    properties: {
      kind: { const: 'list' },
      title: { type: 'string', maxLength: 60 },
      items: { type: 'array', minItems: 2, maxItems: 10, items: text(3, 220) },
    },
  },
};

/** Schema di un pezzo. `allowedKinds` restringe i blocchi al format assegnato. */
export function articleJsonSchema(allowedKinds?: readonly string[]): JsonSchema {
  const kinds = allowedKinds && allowedKinds.length > 0
    ? allowedKinds.filter((k) => k in BLOCK_SCHEMAS)
    : Object.keys(BLOCK_SCHEMAS);

  return {
    type: 'object',
    additionalProperties: false,
    required: ['blocks'],
    properties: {
      blocks: {
        type: 'array', minItems: 1, maxItems: 12,
        items: { anyOf: kinds.map((k) => BLOCK_SCHEMAS[k] as JsonSchema) },
      },
    },
  };
}

/** Schema del lotto di card personali: una riga per presidente. */
export function personalCardsJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cards'],
    properties: {
      cards: {
        type: 'array', minItems: 1, maxItems: 24,
        items: {
          type: 'object', additionalProperties: false,
          required: ['teamId', 'headline', 'body', 'statLabel', 'statValue'],
          properties: {
            teamId: { type: 'string', minLength: 1 },
            headline: text(5, 70),
            body: text(20, 320),
            statLabel: { type: 'string', maxLength: 40 },
            statValue: { type: 'string', maxLength: 16 },
          },
        },
      },
    },
  };
}

/** I blocchi che ogni format sa produrre. Restringere lo schema riduce gli scarti. */
export const FORMAT_BLOCK_KINDS: Record<string, string[]> = {
  intervista_impossibile: ['headline', 'standfirst', 'interview'],
  pagelle_presidenti: ['headline', 'pagella'],
  oroscopo: ['headline', 'list'],
  annunci_economici: ['headline', 'list'],
  previsioni_meteo: ['headline', 'list'],
  listino_borsa: ['headline', 'pagella'],
  epigrafe: ['headline', 'body'],
  necrologio: ['headline', 'body', 'pull_quote'],
  tabellino_commentato: ['headline', 'list', 'boxscore'],
  bollettino_medico: ['headline', 'list'],
};
