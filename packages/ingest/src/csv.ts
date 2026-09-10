/** Parser CSV minimale ma corretto: virgolette, virgole interne, CRLF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const text = input.replace(/^﻿/, ''); // BOM di Excel

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',' || ch === ';') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export type CsvTable = { headers: string[]; rows: Record<string, string>[] };

export function parseCsvTable(input: string): CsvTable {
  const raw = parseCsv(input);
  const headerRow = raw[0];
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map((h) => h.trim());
  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => { record[h] = (cells[i] ?? '').trim(); });
    return record;
  });
  return { headers, rows };
}

export function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

export function optionalNum(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function int(value: string | undefined, fallback = 0): number {
  return Math.trunc(num(value, fallback));
}

export function bool(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sì' || v === 'x';
}
