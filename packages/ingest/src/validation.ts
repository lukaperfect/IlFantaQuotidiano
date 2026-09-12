/**
 * IL CANARY CONTRO I REDESIGN.
 *
 * Una piattaforma terza cambia forma senza avvisare. Il modo per sopravvivere
 * non è sperare: è confrontare la FORMA dei dati con una fixture di
 * riferimento a ogni giornata, PRIMA della finestra di pubblicazione. Un drift
 * rilevato diventa un alert; un drift non rilevato diventa un giornale con i
 * numeri sbagliati.
 */

export type ShapeNode =
  | { t: 'primitive'; type: string }
  | { t: 'array'; of: ShapeNode | null }
  | { t: 'object'; keys: Record<string, ShapeNode> };

/** Impronta strutturale di un payload: chiavi e tipi, senza i valori. */
export function describeShape(value: unknown, depth = 0): ShapeNode {
  if (depth > 8) return { t: 'primitive', type: 'deep' };
  if (value === null) return { t: 'primitive', type: 'null' };
  if (Array.isArray(value)) {
    // Si campiona il primo elemento: gli array omogenei sono la norma nei
    // payload JSON, e campionarli tutti costerebbe senza aggiungere segnale.
    return { t: 'array', of: value.length > 0 ? describeShape(value[0], depth + 1) : null };
  }
  if (typeof value === 'object') {
    const keys: Record<string, ShapeNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      keys[k] = describeShape(v, depth + 1);
    }
    return { t: 'object', keys };
  }
  return { t: 'primitive', type: typeof value };
}

export type DriftKind = 'campo-mancante' | 'campo-nuovo' | 'tipo-cambiato';

export type Drift = {
  kind: DriftKind;
  path: string;
  expected?: string;
  found?: string;
};

export type DriftReport = {
  ok: boolean;
  /** Un campo mancante rompe l'estrazione; un campo nuovo di solito no. */
  breaking: Drift[];
  informational: Drift[];
};

export function detectDrift(current: unknown, golden: unknown): DriftReport {
  const drifts: Drift[] = [];
  compare(describeShape(current), describeShape(golden), '$', drifts);

  const breaking = drifts.filter((d) => d.kind !== 'campo-nuovo');
  return { ok: breaking.length === 0, breaking, informational: drifts.filter((d) => d.kind === 'campo-nuovo') };
}

function compare(current: ShapeNode, golden: ShapeNode, path: string, out: Drift[]): void {
  if (current.t !== golden.t) {
    out.push({ kind: 'tipo-cambiato', path, expected: golden.t, found: current.t });
    return;
  }
  if (golden.t === 'primitive' && current.t === 'primitive') {
    // null è ammesso ovunque: un campo opzionale valorizzato a volte e a
    // volte no non è un drift, è la normalità.
    if (current.type !== golden.type && current.type !== 'null' && golden.type !== 'null') {
      out.push({ kind: 'tipo-cambiato', path, expected: golden.type, found: current.type });
    }
    return;
  }
  if (golden.t === 'array' && current.t === 'array') {
    if (golden.of && current.of) compare(current.of, golden.of, `${path}[]`, out);
    return;
  }
  if (golden.t === 'object' && current.t === 'object') {
    for (const [key, goldenChild] of Object.entries(golden.keys)) {
      const currentChild = current.keys[key];
      if (!currentChild) {
        out.push({ kind: 'campo-mancante', path: `${path}.${key}`, expected: goldenChild.t });
        continue;
      }
      compare(currentChild, goldenChild, `${path}.${key}`, out);
    }
    for (const key of Object.keys(current.keys)) {
      if (!(key in golden.keys)) out.push({ kind: 'campo-nuovo', path: `${path}.${key}` });
    }
  }
}

export function formatDriftReport(report: DriftReport): string {
  if (report.ok && report.informational.length === 0) {
    return 'Nessuna deriva: la forma dei dati corrisponde alla fixture di riferimento.';
  }
  const lines: string[] = [];
  if (report.breaking.length > 0) {
    lines.push(`DERIVA BLOCCANTE (${report.breaking.length}):`);
    for (const d of report.breaking) {
      lines.push(`  - ${d.path}: ${d.kind}${d.expected ? ` (atteso ${d.expected}, trovato ${d.found ?? 'niente'})` : ''}`);
    }
  }
  if (report.informational.length > 0) {
    lines.push(`Campi nuovi, non bloccanti (${report.informational.length}):`);
    for (const d of report.informational) lines.push(`  - ${d.path}`);
  }
  return lines.join('\n');
}
