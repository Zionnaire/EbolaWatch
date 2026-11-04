export type CsvCell = string | number | boolean | null | undefined;

/** A spreadsheet treats a cell starting with = + - @ (or a control character) as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value); // numbers are never formulas
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV (CRLF line endings) with spreadsheet formula-injection protection for text cells. */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
