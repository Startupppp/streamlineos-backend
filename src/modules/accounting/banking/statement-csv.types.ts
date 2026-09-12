/**
 * The shapes of a statement import: the column mapping a caller declares, and
 * the rows, skipped rows and duplicate groups a parse produces. The parse
 * itself is in `statement-csv.ts`.
 */
import type { DecimalSeparator } from "./lib/statement-amounts";
import type { StatementDateFormat } from "./lib/statement-dates";

export interface StatementColumnMapping {
  dateColumn: string;
  descriptionColumn?: string;
  referenceColumn?: string;
  /** A single signed column… */
  amountColumn?: string;
  /** …or a debit/credit pair. Debit is money out, credit is money in. */
  debitColumn?: string;
  creditColumn?: string;
  /** Required. Never inferred — see the header of `statement-csv.ts`. */
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

/**
 * A mapping as it arrives from a request body or a `jsonb` column: every field
 * optional, and `dateFormat` still a bare string until it is checked.
 */
export type LooseColumnMapping = Partial<Omit<StatementColumnMapping, "dateFormat">> & {
  dateFormat?: string;
};

export interface DuplicateLineGroup {
  valueDate: string;
  amountMinor: number;
  bankReference: string | null;
  lineNos: number[];
}
