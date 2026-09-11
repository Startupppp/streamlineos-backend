/**
 * The shapes of a statement import: what a caller sends, what an import
 * returns, and the statement summary the read paths share.
 * `statement-import.service.ts` re-exports every one of them.
 */
import type { StatementColumnMapping } from "./statement-csv";

export type ImportWarningCode =
  | "DUPLICATE_LINE"
  | "ROW_SKIPPED"
  | "LINE_OUTSIDE_PERIOD";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ImportStatementInput {
  bankProfileId: string;
  /** The raw file, as a string. No multipart, no upload dependency. */
  content: string;
  fileName?: string;
  /** A named layout, an explicit mapping, or neither (falls back to the saved one). */
  presetCode?: string;
  mapping?: Partial<StatementColumnMapping>;
  periodStart: string;
  periodEnd: string;
  /** Decimal strings in the bank account's currency, e.g. `"10000.00"`. */
  opening: string;
  closing: string;
}

export interface ImportedStatementLine {
  id: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
}

export interface StatementImportResult {
  statementId: string;
  bankProfileId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  movementMinor: number;
  lineCount: number;
  fileHash: string;
  warnings: ImportWarning[];
  lines: ImportedStatementLine[];
}

export interface StatementSummary {
  id: string;
  bankProfileId: string;
  bookId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  source: "csv" | "manual" | "feed";
  fileName: string | null;
  fileHash: string | null;
  lineCount: number;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  importedAt: Date;
}
