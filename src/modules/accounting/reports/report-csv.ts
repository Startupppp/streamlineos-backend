/**
 * CSV rendering for every report.
 *
 * One writer, because a per-report `join(",")` is how an account named
 * `Smith, Jones & Co` silently shifts every column to its right — and how a
 * party name beginning `=` becomes a formula the moment the file is opened in a
 * spreadsheet.
 */
import { money, toDecimalString } from "../kernel/money";

export type CsvCell = string | number | boolean | null | undefined;

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);

  // Numbers are ours, so a leading "-" on one is a minus sign, not an attack.
  // Only text the tenant supplied gets the apostrophe guard.
  if (typeof value === "string" && text.length > 0 && FORMULA_PREFIXES.has(text[0]!)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** RFC-4180 rows with CRLF endings, which is what Excel expects. */
export function toCsv(headers: readonly CsvCell[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A money column as a decimal string, so a spreadsheet sums it correctly and a
 * human reads `11800.00` rather than `1180000`. Minor units stay the number of
 * record everywhere else; this is presentation only.
 */
export function csvMoney(minor: number, currency: string): string {
  return toDecimalString(money(minor, currency));
}

/**
 * Prepend the "what am I looking at" preamble every export needs — a CSV that
 * has lost its filename should still say which org, which report and as of when.
 */
export function withCsvPreamble(
  preamble: ReadonlyArray<readonly [string, CsvCell]>,
  body: string,
): string {
  const head = preamble.map(([k, v]) => `${escapeCell(k)},${escapeCell(v)}`).join("\r\n");
  return `${head}\r\n\r\n${body}`;
}

/**
 * `trial-balance-2026-08-25.csv` — safe on every filesystem and inside a
 * `Content-Disposition` header.
 *
 * Dots are stripped along with everything else outside `[A-Za-z0-9_-]`, so no
 * input can contribute a `..` segment or a second extension. Today the parts
 * come from an enum and an ISO date; this stays true if that ever changes.
 */
export function csvFilename(parts: readonly string[]): string {
  const slug = parts
    .join("-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "report"}.csv`;
}
