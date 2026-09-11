/**
 * Pure CSV → statement-line parsing for PRD 04.
 *
 * Nothing here touches the database, so every edge case the PRD names — the
 * `03/04/2026` that is 3 April in Mumbai and 4 March in Denver, the
 * `₹ 1,00,000.00` that is not a float, the withdrawal column that means
 * "negative" — is decided by a pure function with a test.
 *
 * Two rules the rest of the import depends on:
 *
 * 1. **The date format is declared, never guessed.** There is no heuristic in
 *    this file. A caller that does not say `DD/MM/YYYY` or `MM/DD/YYYY` gets a
 *    rejection, because guessing wrong silently moves money between months.
 * 2. **Amounts land as integer minor units** via `fromDecimalString`, which
 *    refuses excess precision. A number that is not a clean decimal after the
 *    documented cleanup is a rejection, not a `parseFloat`.
 */
import { fromDecimalString, minorUnitsOf, MoneyError } from "../kernel/money";
import { assertIsoDate, FiscalCalendarError } from "../kernel/fiscal-calendar";

/* ------------------------------------------------------------ date layouts */

/**
 * Every layout the importer accepts, spelled out. `DD/MM/YYYY` and
 * `MM/DD/YYYY` share a regex and differ only in field order — which is exactly
 * why one of them has to be named by the caller.
 */
export const SUPPORTED_DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
  "DD-MMM-YYYY",
  "MMM DD, YYYY",
] as const;

export type StatementDateFormat = (typeof SUPPORTED_DATE_FORMATS)[number];

type DatePart = "Y" | "M" | "D" | "MON";

interface DateLayout {
  readonly pattern: RegExp;
  readonly order: readonly [DatePart, DatePart, DatePart];
}

const DATE_LAYOUTS: Readonly<Record<StatementDateFormat, DateLayout>> = Object.freeze({
  "YYYY-MM-DD": { pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ["Y", "M", "D"] },
  "YYYY/MM/DD": { pattern: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: ["Y", "M", "D"] },
  "DD/MM/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ["D", "M", "Y"] },
  "MM/DD/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ["M", "D", "Y"] },
  "DD-MM-YYYY": { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["D", "M", "Y"] },
  "MM-DD-YYYY": { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["M", "D", "Y"] },
  "DD.MM.YYYY": { pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ["D", "M", "Y"] },
  "DD-MMM-YYYY": { pattern: /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/, order: ["D", "MON", "Y"] },
  "MMM DD, YYYY": { pattern: /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/, order: ["MON", "D", "Y"] },
});

const MONTH_ABBREVIATIONS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

/** A trailing clock reading — banks love `2026-04-03 10:22:00` in a date column. */
const TRAILING_TIME = /[\sT]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AP]\.?M\.?)?(\s*[A-Z]{2,4})?$/i;

export class StatementCsvError extends Error {
  constructor(
    message: string,
    /** 1-based row number in the source file, when the problem is on one row. */
    readonly rowNumber?: number,
    readonly column?: string,
  ) {
    super(message);
    this.name = "StatementCsvError";
  }
}

export function isSupportedDateFormat(value: string): value is StatementDateFormat {
  return (SUPPORTED_DATE_FORMATS as readonly string[]).includes(value);
}

/**
 * `raw` under the declared `format`, as an ISO `YYYY-MM-DD`.
 *
 * `parseStatementDate("03/04/2026", "DD/MM/YYYY")` is `2026-04-03`;
 * `parseStatementDate("03/04/2026", "MM/DD/YYYY")` is `2026-03-04`. Both are
 * correct, which is the entire point of making the caller choose.
 */
export function parseStatementDate(raw: string, format: StatementDateFormat): string {
  const layout = DATE_LAYOUTS[format];
  if (!layout) {
    throw new StatementCsvError(
      `Unsupported date format ${JSON.stringify(format)}. ` +
        `Declare one of: ${SUPPORTED_DATE_FORMATS.join(", ")}.`,
    );
  }

  const text = raw.trim().replace(TRAILING_TIME, "").trim();
  const match = layout.pattern.exec(text);
  if (!match) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a ${format} date. The import declared ${format}; ` +
        "fix the mapping or the file rather than letting the importer guess.",
    );
  }

  let year = 0;
  let month = 0;
  let day = 0;
  layout.order.forEach((part, index) => {
    const value = match[index + 1];
    if (part === "Y") year = Number(value);
    else if (part === "M") month = Number(value);
    else if (part === "D") day = Number(value);
    else {
      const resolved = MONTH_ABBREVIATIONS[value.toLowerCase()];
      if (!resolved) {
        throw new StatementCsvError(`${JSON.stringify(value)} is not a month abbreviation`);
      }
      month = resolved;
    }
  });

  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  try {
    return assertIsoDate(iso);
  } catch (error) {
    if (error instanceof FiscalCalendarError) {
      throw new StatementCsvError(
        `${JSON.stringify(raw)} read as ${format} gives ${iso}, which is not a real calendar date`,
      );
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- amounts */

/** Symbols that may sit against a number without changing it. */
const CURRENCY_SYMBOLS = /[₹$€£¥₨₩₪₫₴₺¢₦₱฿]/g;
const WHITESPACE = /\s/g;

export type DecimalSeparator = "." | ",";

/**
 * A CSV cell as integer minor units of `currency`, or `null` when the cell is
 * blank.
 *
 * Handles the shapes real exports use — `1,234.56`, `₹ 1,00,000.00`,
 * `(200.00)`, `500.00 CR`, `INR 42.00`, `1.234,56` under a comma separator —
 * and rejects everything else rather than coercing it. `12abc` is a rejection,
 * not `12`.
 */
export function parseAmountToMinor(
  raw: string,
  currency: string,
  separator: DecimalSeparator = ".",
): number | null {
  const scale = minorUnitsOf(currency);
  let text = raw.replace(WHITESPACE, "");
  if (text === "") return null;

  let negative = false;

  // Accountancy parentheses: (200.00) is minus two hundred.
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(CURRENCY_SYMBOLS, "");

  // A leading or trailing currency/side token, and nothing else alphabetic. A
  // narrow allowlist so `12abc` still fails instead of quietly becoming 12.
  const noise = new Set(["CR", "DR", "RS", "RS.", "INR", currency.toUpperCase()]);
  const leading = /^([A-Za-z]{2,3}\.?)/.exec(text);
  if (leading && noise.has(leading[1].toUpperCase())) {
    if (leading[1].toUpperCase() === "DR") negative = !negative;
    text = text.slice(leading[1].length);
  }
  const trailing = /([A-Za-z]{2,3}\.?)$/.exec(text);
  if (trailing && noise.has(trailing[1].toUpperCase())) {
    if (trailing[1].toUpperCase() === "DR") negative = !negative;
    text = text.slice(0, text.length - trailing[1].length);
  }

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (text === "") return null;

  // Split on the declared decimal separator, then strip grouping marks from the
  // integer part only — a grouping mark in the fraction is a malformed number.
  const groupingMark = separator === "." ? "," : ".";
  const lastSeparator = text.lastIndexOf(separator);
  const wholeRaw = lastSeparator === -1 ? text : text.slice(0, lastSeparator);
  const fraction = lastSeparator === -1 ? "" : text.slice(lastSeparator + 1);

  if (!isGroupedInteger(wholeRaw, groupingMark)) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a clean decimal amount. ` +
        `Expected digits with "${separator}" as the decimal mark.`,
    );
  }
  if (fraction !== "" && !/^\d+$/.test(fraction)) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a clean decimal amount — the fractional part is not numeric.`,
    );
  }
  if (fraction.length > scale) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} carries ${fraction.length} decimal places but ${currency} has ${scale}.`,
    );
  }

  const whole = wholeRaw.split(groupingMark).join("");
  const decimal = `${negative ? "-" : ""}${whole || "0"}${fraction ? `.${fraction}` : ""}`;

  try {
    return fromDecimalString(decimal, currency).minor;
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new StatementCsvError(`${JSON.stringify(raw)} is not a valid ${currency} amount: ${error.message}`);
    }
    throw error;
  }
}

/** `1,00,000` and `1,234,567` pass; `1,,2`, `,12`, `12,` and `12a` do not. */
function isGroupedInteger(value: string, groupingMark: string): boolean {
  if (value === "") return true;
  if (value.startsWith(groupingMark) || value.endsWith(groupingMark)) return false;
  const groups = value.split(groupingMark);
  return groups.every((g) => g.length > 0 && /^\d+$/.test(g));
}

/* ------------------------------------------------------------ CSV reading */

/**
 * RFC 4180 reader — quoted fields, doubled quotes, embedded delimiters and
 * newlines, CRLF or LF. Deliberately hand-written: a bank statement importer
 * should not drag a parsing dependency into the accounting kernel.
 */
export function parseCsv(content: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1) {
    throw new StatementCsvError(`Delimiter must be a single character, got ${JSON.stringify(delimiter)}`);
  }

  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyCharacter = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === "") {
      // Only treat a quote as an opener at the start of a field, so a stray
      // quote mid-narration does not swallow the rest of the file.
      field = "";
      inQuotes = true;
      sawAnyCharacter = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = "";
      sawAnyCharacter = true;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyCharacter = false;
      continue;
    }

    field += ch;
    sawAnyCharacter = true;
  }

  if (inQuotes) {
    throw new StatementCsvError("The file ends inside a quoted field — it is not valid CSV");
  }
  if (field !== "" || row.length > 0 || sawAnyCharacter) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/* ------------------------------------------------------------- the mapping */

export interface StatementColumnMapping {
  dateColumn: string;
  descriptionColumn?: string;
  referenceColumn?: string;
  /** A single signed column… */
  amountColumn?: string;
  /** …or a debit/credit pair. Debit is money out, credit is money in. */
  debitColumn?: string;
  creditColumn?: string;
  /** Required. Never inferred — see the file header. */
  dateFormat: StatementDateFormat;
  /** Preamble rows above the header, as many exports carry a bank letterhead. */
  skipRows?: number;
  delimiter?: string;
  decimalSeparator?: DecimalSeparator;
}

export interface ParsedStatementRow {
  /** 1-based position among the rows that produced a line. */
  lineNo: number;
  /** 1-based row number in the source file, for error messages. */
  sourceRowNumber: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
  rawRow: Record<string, string>;
}

export interface SkippedStatementRow {
  sourceRowNumber: number;
  reason: string;
  rawRow: Record<string, string>;
}

export interface ParsedStatement {
  header: string[];
  rows: ParsedStatementRow[];
  skipped: SkippedStatementRow[];
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A mapping as it arrives from a request body or a `jsonb` column: every field
 * optional, and `dateFormat` still a bare string until it is checked.
 */
export type LooseColumnMapping = Partial<Omit<StatementColumnMapping, "dateFormat">> & {
  dateFormat?: string;
};

/**
 * Validate a mapping in isolation, so a bad preset or a bad saved mapping is
 * caught before a single row is read.
 */
export function assertMappingIsUsable(mapping: LooseColumnMapping): StatementColumnMapping {
  if (!mapping.dateFormat) {
    throw new StatementCsvError(
      "A statement import must declare its date format. `03/04/2026` is 3 April under " +
        "DD/MM/YYYY and 4 March under MM/DD/YYYY, and the importer will not guess. " +
        `Declare one of: ${SUPPORTED_DATE_FORMATS.join(", ")}.`,
    );
  }
  if (!isSupportedDateFormat(mapping.dateFormat)) {
    throw new StatementCsvError(
      `Unsupported date format ${JSON.stringify(mapping.dateFormat)}. ` +
        `Declare one of: ${SUPPORTED_DATE_FORMATS.join(", ")}.`,
    );
  }
  if (!mapping.dateColumn?.trim()) {
    throw new StatementCsvError("A statement import must name the date column");
  }

  const hasAmount = Boolean(mapping.amountColumn?.trim());
  const hasPair = Boolean(mapping.debitColumn?.trim() || mapping.creditColumn?.trim());
  if (hasAmount && hasPair) {
    throw new StatementCsvError(
      "Declare either a single signed amount column or a debit/credit pair, not both",
    );
  }
  if (!hasAmount && !hasPair) {
    throw new StatementCsvError(
      "A statement import must name either an amount column or a debit/credit pair",
    );
  }

  return {
    dateColumn: mapping.dateColumn,
    descriptionColumn: mapping.descriptionColumn,
    referenceColumn: mapping.referenceColumn,
    amountColumn: mapping.amountColumn,
    debitColumn: mapping.debitColumn,
    creditColumn: mapping.creditColumn,
    dateFormat: mapping.dateFormat,
    skipRows: mapping.skipRows,
    delimiter: mapping.delimiter,
    decimalSeparator: mapping.decimalSeparator,
  };
}

/** Read a whole file into statement lines under an explicit mapping. */
export function parseStatementCsv(
  content: string,
  rawMapping: LooseColumnMapping,
  currency: string,
): ParsedStatement {
  const mapping = assertMappingIsUsable(rawMapping);
  const separator = mapping.decimalSeparator ?? ".";
  const grid = parseCsv(content, mapping.delimiter ?? ",");

  const skipRows = mapping.skipRows ?? 0;
  const body = grid.slice(skipRows);
  const headerRow = body[0];
  if (!headerRow) {
    throw new StatementCsvError("The file has no header row to map columns against");
  }

  const headerIndex = new Map<string, number>();
  headerRow.forEach((name, index) => {
    const key = normalizeHeader(name);
    if (key !== "" && !headerIndex.has(key)) headerIndex.set(key, index);
  });

  const available = headerRow.map((h) => h.trim()).filter((h) => h !== "");
  const columnOf = (declared: string | undefined, required: boolean): number | null => {
    if (!declared?.trim()) return null;
    const index = headerIndex.get(normalizeHeader(declared));
    if (index === undefined) {
      if (!required) return null;
      throw new StatementCsvError(
        `The file has no column named ${JSON.stringify(declared)}. ` +
          `Columns present: ${available.map((h) => JSON.stringify(h)).join(", ") || "(none)"}.`,
      );
    }
    return index;
  };

  const dateAt = columnOf(mapping.dateColumn, true);
  const amountAt = columnOf(mapping.amountColumn, true);
  const debitAt = columnOf(mapping.debitColumn, true);
  const creditAt = columnOf(mapping.creditColumn, true);
  const descriptionAt = columnOf(mapping.descriptionColumn, false);
  const referenceAt = columnOf(mapping.referenceColumn, false);

  const rows: ParsedStatementRow[] = [];
  const skipped: SkippedStatementRow[] = [];

  for (let i = 1; i < body.length; i++) {
    const cells = body[i];
    const sourceRowNumber = skipRows + i + 1;
    const rawRow = toRawRow(headerRow, cells);

    if (cells.every((c) => c.trim() === "")) continue;

    const cell = (index: number | null): string => (index === null ? "" : (cells[index] ?? ""));

    const dateCell = cell(dateAt);
    if (dateCell.trim() === "") {
      skipped.push({ sourceRowNumber, reason: "no date", rawRow });
      continue;
    }

    let valueDate: string;
    let amountMinor: number | null;
    try {
      valueDate = parseStatementDate(dateCell, mapping.dateFormat);
      amountMinor =
        amountAt !== null
          ? parseAmountToMinor(cell(amountAt), currency, separator)
          : signedFromPair(
              parseAmountToMinor(cell(debitAt), currency, separator),
              parseAmountToMinor(cell(creditAt), currency, separator),
              sourceRowNumber,
            );
    } catch (error) {
      if (error instanceof StatementCsvError) {
        throw new StatementCsvError(`Row ${sourceRowNumber}: ${error.message}`, sourceRowNumber);
      }
      throw error;
    }

    if (amountMinor === null || amountMinor === 0) {
      // A zero movement cannot be stored (`amount_minor <> 0`) and is never
      // meaningful. Surfaced, never silently dropped.
      skipped.push({ sourceRowNumber, reason: "no movement on the row", rawRow });
      continue;
    }

    rows.push({
      lineNo: rows.length + 1,
      sourceRowNumber,
      valueDate,
      amountMinor,
      description: trimToNull(cell(descriptionAt)),
      bankReference: trimToNull(cell(referenceAt)),
      rawRow,
    });
  }

  return { header: available, rows, skipped };
}

/** Debit is money out, credit is money in. Both on one row is a malformed row. */
function signedFromPair(debit: number | null, credit: number | null, rowNumber: number): number | null {
  const out = debit ?? 0;
  const inn = credit ?? 0;
  if (out !== 0 && inn !== 0) {
    throw new StatementCsvError(
      `Row ${rowNumber} carries both a withdrawal and a deposit; a statement line is one or the other`,
      rowNumber,
    );
  }
  if (out !== 0) return -Math.abs(out);
  if (inn !== 0) return Math.abs(inn);
  return null;
}

function toRawRow(header: string[], cells: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  header.forEach((name, index) => {
    const key = name.trim();
    if (key !== "") row[key] = cells[index] ?? "";
  });
  return row;
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/* ------------------------------------------------------- duplicate lines */

export interface DuplicateLineGroup {
  valueDate: string;
  amountMinor: number;
  bankReference: string | null;
  lineNos: number[];
}

/**
 * Same date, same amount, same reference, twice in one file.
 *
 * Reported, never removed: a genuine pair of identical ₹500 UPI collections on
 * the same day is common, and an importer that silently deduplicates them loses
 * real money. The human decides.
 */
export function findDuplicateLines(rows: readonly ParsedStatementRow[]): DuplicateLineGroup[] {
  const groups = new Map<string, DuplicateLineGroup>();
  for (const row of rows) {
    const key = `${row.valueDate}|${row.amountMinor}|${(row.bankReference ?? "").toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) existing.lineNos.push(row.lineNo);
    else
      groups.set(key, {
        valueDate: row.valueDate,
        amountMinor: row.amountMinor,
        bankReference: row.bankReference,
        lineNos: [row.lineNo],
      });
  }
  return [...groups.values()].filter((g) => g.lineNos.length > 1);
}
