import {
  parseEnvelope, applyMapping, mappingCoverage, detectDrift,
  FieldMappingSchema, AdapterError,
} from '@fantacomics/ingest';

export const dynamic = 'force-dynamic';

/**
 * L'endpoint dell'estensione browser.
 *
 * Riceve i payload JSON che la pagina della piattaforma ha già scaricato nella
 * sessione dell'utente. Tre proprietà che nessuno scraping lato server ha:
 * nessuna credenziale custodita, nessun rischio di ban (traffico dell'utente,
 * volumi umani), e payload che cambiano molto più lentamente del DOM.
 *
 * Il mapping dei campi arriva dal server, quindi una deriva della piattaforma
 * si corregge senza ripubblicare l'estensione e aspettare che gli utenti
 * aggiornino.
 */

const CAMPI_RICHIESTI = ['playerId', 'vote'] as const;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ errore: 'Corpo non JSON.' }, { status: 400 });
  }

  try {
    // Tutto ciò che arriva da un client è ostile finché non è validato.
    const envelope = parseEnvelope(body);

    const rawMapping = (body as { mapping?: unknown }).mapping;
    if (rawMapping === undefined) {
      return Response.json({
        accettato: true,
        clientVersion: envelope.clientVersion,
        payloads: Object.keys(envelope.payloads),
        nota: 'Envelope valido. Nessun mapping fornito: nulla è stato estratto.',
      });
    }

    const mapping = FieldMappingSchema.parse(rawMapping);
    const payload = envelope.payloads[Object.keys(envelope.payloads)[0] ?? ''];
    const records = applyMapping(payload, mapping);
    const coverage = mappingCoverage(records, CAMPI_RICHIESTI);

    // La copertura è il segnale del canary: se crolla, la piattaforma è
    // cambiata sotto i piedi e il mapping va aggiornato prima di pubblicare.
    const sano = coverage.ratio >= 0.95;

    return Response.json({
      accettato: true,
      clientVersion: envelope.clientVersion,
      matchday: envelope.matchday,
      record: records.length,
      copertura: Number(coverage.ratio.toFixed(3)),
      campiMancanti: coverage.missing,
      stato: sano ? 'ok' : 'deriva-sospetta',
    }, { status: sano ? 200 : 422 });
  } catch (e) {
    if (e instanceof AdapterError) {
      return Response.json({ errore: e.message, tipo: e.kind }, { status: 422 });
    }
    return Response.json(
      { errore: e instanceof Error ? e.message : 'Errore sconosciuto.' },
      { status: 400 },
    );
  }
}

/** Confronto di forma contro una fixture di riferimento: il canary su richiesta. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const { corrente, riferimento } = (await request.json()) as {
      corrente: unknown; riferimento: unknown;
    };
    const report = detectDrift(corrente, riferimento);
    return Response.json(report, { status: report.ok ? 200 : 422 });
  } catch (e) {
    return Response.json(
      { errore: e instanceof Error ? e.message : 'Errore sconosciuto.' },
      { status: 400 },
    );
  }
}
