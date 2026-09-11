/**
 * The importer's checks, each a 400 with a sentence a person can act on.
 *
 * The date format is declared, never defaulted (`resolveMapping`), and
 * `opening + movements = closing` or nothing is written (`assertTies`). The
 * warnings are what an import reports without refusing it: duplicate lines,
 * skipped rows, and lines dated outside the declared period.
 */
import { BadRequestException } from "@nestjs/common";
import { assertIsoDate, compareDates } from "../../kernel/fiscal-calendar";
import { money, toDecimalString } from "../../kernel/money";
import { findMappingPreset, STATEMENT_MAPPING_PRESETS } from "../csv-presets";
import {
  assertMappingIsUsable,
  findDuplicateLines,
  parseAmountToMinor,
  parseStatementCsv,
  StatementCsvError,
  type LooseColumnMapping,
  type ParsedStatement,
  type StatementColumnMapping,
} from "../statement-csv";
import type { ImportWarning } from "../statement-import.types";

/** `parseStatementCsv`, with a parse failure turned into a 400 carrying its message. */
export function parseStatementOrReject(
  content: string,
  mapping: StatementColumnMapping,
  currency: string,
): ParsedStatement {
  try {
    return parseStatementCsv(content, mapping, currency);
  } catch (error) {
    if (error instanceof StatementCsvError) throw new BadRequestException(error.message);
    throw error;
  }
}

/**
 * Mapping precedence: what the request says, over the named preset, over what
 * the account has saved. A missing `dateFormat` at the end of that chain is a
 * rejection, not a default.
 */
export function resolveMapping(
  saved: LooseColumnMapping | null,
  presetCode: string | undefined,
  explicit: LooseColumnMapping | undefined,
): StatementColumnMapping {
  let base: LooseColumnMapping = saved ?? {};
  if (presetCode) {
    const preset = findMappingPreset(presetCode);
    if (!preset) {
      throw new BadRequestException(
        `Unknown CSV mapping preset ${JSON.stringify(presetCode)}. ` +
          `Known presets: ${STATEMENT_MAPPING_PRESETS.map((p) => p.code).join(", ")}.`,
      );
    }
    base = preset.mapping;
  }

  const merged: LooseColumnMapping = { ...base, ...(explicit ?? {}) };
  if (!presetCode && !explicit && !saved) {
    throw new BadRequestException(
      "This bank account has no saved CSV mapping. Send a mapping, or name a preset, or save one " +
        "against the account first.",
    );
  }

  try {
    return assertMappingIsUsable(merged);
  } catch (error) {
    if (error instanceof StatementCsvError) throw new BadRequestException(error.message);
    throw error;
  }
}

export function requireAmount(raw: string, currency: string, field: string): number {
  let parsed: number | null;
  try {
    parsed = parseAmountToMinor(String(raw ?? ""), currency);
  } catch (error) {
    if (error instanceof StatementCsvError) {
      throw new BadRequestException(`${field}: ${error.message}`);
    }
    throw error;
  }
  if (parsed === null) {
    throw new BadRequestException(
      `${field} is required — a statement without a stated ${field} balance cannot be tied out`,
    );
  }
  return parsed;
}

/** `opening + sum(lines) == closing`, loudly. */
export function assertTies(
  openingMinor: number,
  movementMinor: number,
  closingMinor: number,
  currency: string,
  lineCount: number,
): void {
  const expected = openingMinor + movementMinor;
  if (expected === closingMinor) return;

  const difference = closingMinor - expected;
  throw new BadRequestException(
    `The statement does not tie: opening ${toDecimalString(money(openingMinor, currency))} ` +
      `+ ${lineCount} lines totalling ${toDecimalString(money(movementMinor, currency))} ` +
      `= ${toDecimalString(money(expected, currency))}, but the closing balance says ` +
      `${toDecimalString(money(closingMinor, currency))} — a difference of ` +
      `${toDecimalString(money(difference, currency))} ${currency}. Nothing was imported.`,
  );
}

export function collectWarnings(
  parsed: ReturnType<typeof parseStatementCsv>,
  periodStart: string,
  periodEnd: string,
  currency: string,
): ImportWarning[] {
  const warnings: ImportWarning[] = [];

  for (const group of findDuplicateLines(parsed.rows)) {
    warnings.push({
      code: "DUPLICATE_LINE",
      message:
        `Lines ${group.lineNos.join(", ")} are identical — ${group.valueDate}, ` +
        `${toDecimalString(money(group.amountMinor, currency))} ${currency}` +
        `${group.bankReference ? `, reference ${group.bankReference}` : ", no reference"}. ` +
        "Both were imported; confirm they are two real movements and not a double export.",
      details: {
        valueDate: group.valueDate,
        amountMinor: group.amountMinor,
        bankReference: group.bankReference,
        lineNos: group.lineNos,
      },
    });
  }

  for (const skipped of parsed.skipped) {
    warnings.push({
      code: "ROW_SKIPPED",
      message: `Row ${skipped.sourceRowNumber} was skipped: ${skipped.reason}`,
      details: { sourceRowNumber: skipped.sourceRowNumber, rawRow: skipped.rawRow },
    });
  }

  const outside = parsed.rows.filter(
    (r) => compareDates(r.valueDate, periodStart) < 0 || compareDates(r.valueDate, periodEnd) > 0,
  );
  for (const row of outside) {
    warnings.push({
      code: "LINE_OUTSIDE_PERIOD",
      message:
        `Line ${row.lineNo} is dated ${row.valueDate}, outside the declared period ` +
        `${periodStart} → ${periodEnd}. Check the declared date format before trusting it.`,
      details: { lineNo: row.lineNo, valueDate: row.valueDate },
    });
  }

  return warnings;
}

export function isoOrReject(value: string, field: string): string {
  try {
    return assertIsoDate(value);
  } catch {
    throw new BadRequestException(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
}
