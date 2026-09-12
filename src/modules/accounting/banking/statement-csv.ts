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
import { parseCsv } from "./lib/csv-reader";
import { parseAmountToMinor } from "./lib/statement-amounts";
import { StatementCsvError } from "./lib/statement-csv-error";
import { isSupportedDateFormat, parseStatementDate, SUPPORTED_DATE_FORMATS } from "./lib/statement-dates";
import type {
  DuplicateLineGroup,
  LooseColumnMapping,
  ParsedStatement,
  ParsedStatementRow,
  SkippedStatementRow,
  StatementColumnMapping,
} from "./statement-csv.types";

/*
  The dialect pieces live in lib/: the date layouts in statement-dates.ts, the
  amount cleanup in statement-amounts.ts, the RFC 4180 reader in csv-reader.ts.
  They are re-exported here so every caller keeps importing from this file.
*/
export { parseCsv } from "./lib/csv-reader";
export { parseAmountToMinor } from "./lib/statement-amounts";
export { StatementCsvError } from "./lib/statement-csv-error";
export { parseStatementDate, SUPPORTED_DATE_FORMATS } from "./lib/statement-dates";
export type {
  DuplicateLineGroup,
  LooseColumnMapping,
  ParsedStatement,
  ParsedStatementRow,
  StatementColumnMapping,
} from "./statement-csv.types";

/* ------------------------------------------------------------- the mapping */

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

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
