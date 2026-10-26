export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

export function sanitizeCsvCell(value: unknown): string {
  // Convert null/undefined to empty string
  const stringValue = value == null ? "" : String(value);
  // If the string starts with any formula injection prefix, prepend a single quote.
  if (/^[=+\-@]/.test(stringValue)) {
    return `'${stringValue}`;
  }
  return stringValue;
}

/**
 * Escapes a single cell for CSV output.
 *
 * The value is first hardened against formula injection (see
 * {@link sanitizeCsvCell}) and then quoted per RFC 4180: it is wrapped in double
 * quotes and any embedded double quote is doubled. Quoting every cell keeps
 * commas, quotes, and newlines contained within a single column.
 */
export function escapeCsvCell(value: unknown): string {
  // Redaction replaces sensitive values with a `{ $redacted: ... }` object.
  // Serializing it as JSON (instead of `[object Object]`) keeps the reason
  // visible while the surrounding quotes keep its quotes/commas in one cell.
  const serialized =
    typeof value === "object" && value !== null ? JSON.stringify(value) : sanitizeCsvCell(value);
  const sanitized = sanitizeCsvCell(serialized);
  return `"${sanitized.replaceAll('"', '""')}"`;
}

/**
 * Serializes rows into a CSV document. The header is derived from the first
 * row so every column order stays stable, and each data cell is quoted with
 * {@link escapeCsvCell}. Returns an empty string when there is nothing to
 * write, so callers can use it as the response body directly.
 */
export function toCsv(rows: CsvRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0] ?? {});
  const lines = [headers.join(",")];

  for (const row of rows) {
    const line = headers.map((header) => escapeCsvCell(row[header] ?? "")).join(",");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}
