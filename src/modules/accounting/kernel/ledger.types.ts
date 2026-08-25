import type { GlJournalSource } from "../../../db/schema";

/**
 * The kernel's public surface. Every document, adapter and manual entry in the
 * product reaches the general ledger through exactly these two commands — there
 * is no other writer (PRD 07 M1).
 */

export interface PostJournalLineCommand {
  accountId: string;
  /** Exactly one of these is greater than zero, in functional minor units. */
  debitMinor?: number;
  creditMinor?: number;

  /** What the document was denominated in. Defaults to the book's base. */
  txnCurrency?: string;
  txnAmountMinor?: number;

  /**
   * Functional amount. Optional only when the line is already in base
   * currency, where it equals the debit or credit.
   */
  functionalAmountMinor?: number;
  /** Multiplier from txn into functional. Must be `1` for same-currency lines. */
  fxRate?: string;
  fxRateId?: string;

  partyId?: string;
  taxCodeId?: string;
  taxComponent?: string;

  dimensionBranchId?: string;
  dimensionProjectId?: number;
  dimensionCostCenterId?: string;
  dimensionValues?: Record<string, string>;

  description?: string;
}

export interface PostJournalCommand {
  bookId: string;
  /**
   * Caller-supplied and required. Convention is
   * `{sourceType}:{sourceId}:{purpose}` (PRD 07 M4), which makes a retry from
   * any layer land on the same key.
   */
  idempotencyKey: string;
  /** The accounting date, from the document. Never `now()`. */
  journalDate: string;
  memo?: string;
  sourceType: GlJournalSource;
  sourceId?: string;
  lines: PostJournalLineCommand[];
}

export interface ReverseJournalCommand {
  bookId: string;
  journalId: string;
  /** May differ from the original; its period must be open. */
  journalDate?: string;
  idempotencyKey: string;
  memo?: string;
}

export interface PostedJournalLine {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
  txnCurrency: string;
  txnAmountMinor: number;
  functionalCurrency: string;
  functionalAmountMinor: number;
  fxRate: string;
  description: string | null;
}

export interface PostedJournal {
  id: string;
  bookId: string;
  journalNumber: string;
  journalDate: string;
  periodId: string;
  memo: string | null;
  sourceType: GlJournalSource;
  sourceId: string | null;
  idempotencyKey: string;
  reversesJournalId: string | null;
  reversedByJournalId: string | null;
  postedByUserId: string | null;
  postedAt: Date;
  totalDebitMinor: number;
  totalCreditMinor: number;
  functionalCurrency: string;
  lines: PostedJournalLine[];
  /** True when an idempotent replay returned the original rather than posting. */
  replayed: boolean;
}

/* ---------------------------------------------------------------- errors */

export type LedgerRejectionCode =
  | "EMPTY_JOURNAL"
  | "UNBALANCED"
  | "LINE_SIDE_INVALID"
  | "LINE_AMOUNT_INVALID"
  | "CURRENCY_INVALID"
  | "FX_RATE_INVALID"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_IS_HEADER"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_CURRENCY_RESTRICTED"
  | "PERIOD_NOT_FOUND"
  | "PERIOD_LOCKED"
  | "BOOK_NOT_FOUND"
  | "JOURNAL_NOT_FOUND"
  | "ALREADY_REVERSED"
  | "IDEMPOTENCY_CONFLICT";

/**
 * A rejection carries a machine-readable code and, where the problem is on a
 * specific line, that line's index — so a UI can highlight the offending row
 * instead of showing "posting failed".
 */
export class LedgerRejection extends Error {
  constructor(
    readonly code: LedgerRejectionCode,
    message: string,
    readonly lineIndex?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LedgerRejection";
  }
}
