/**
 * Centralized filename builder for audit export downloads. Every value that
 * ends up in `Content-Disposition: attachment; filename=...` must go through
 * {@link buildAuditExportFilename} so a future caller can never slip a
 * newline, quote, or path separator into the header.
 */

export type AuditExportScope = "all" | "mine";
export type AuditExportFormat = "csv" | "json";

const UNSAFE_FILENAME_CHARS = /[\x00-\x1f\x7f"\\/]/g;

/**
 * Strips control characters (including CR/LF, which could otherwise inject a
 * second header line), double quotes, backslashes, and path separators from
 * a single filename segment. Returns "export" if nothing safe remains.
 */
export function sanitizeFilenameSegment(value: string): string {
  const stripped = value.replace(UNSAFE_FILENAME_CHARS, "");
  return stripped.length > 0 ? stripped : "export";
}

/**
 * Builds the exact filename used in the audit export's Content-Disposition
 * header, e.g. "fortexa-audit-all-2026-10-22.csv".
 */
export function buildAuditExportFilename(
  scope: AuditExportScope,
  format: AuditExportFormat = "csv",
  date: Date = new Date(),
): string {
  const safeScope = sanitizeFilenameSegment(scope);
  const safeFormat = sanitizeFilenameSegment(format);
  const datePart = date.toISOString().slice(0, 10);
  return `fortexa-audit-${safeScope}-${datePart}.${safeFormat}`;
}
