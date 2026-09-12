import { HttpException, HttpStatus } from "@nestjs/common";
import type { GlJournalSource, GlSystemTag } from "../../../db/schema";

/**
 * The anti-corruption layer's inbound contract (PRD 07).
 *
 * Other modules describe what happened in **their** vocabulary — "salary
 * expense", "net pay", "PF payable" — and accounting decides which account that
 * is. Nothing outside accounting names a GL account id, and nothing outside
 * accounting inserts a journal line.
 *
 * A caller may name an account either by `accountTag` (preferred — survives a
 * tenant renumbering their chart) or by `accountId` when it genuinely knows one.
 */
export interface PostingCommandLine {
  /** Preferred: the role, resolved against this book's chart. */
  accountTag?: GlSystemTag;
  /** Escape hatch when the caller already resolved an account. */
  accountId?: string;

  debitMinor?: number;
  creditMinor?: number;
  /** Defaults to the book's base currency. */
  currency?: string;
  txnAmountMinor?: number;
  fxRate?: string;

  description?: string;
  /** Resolved to a party id via `external_refs`; never creates a duplicate. */
  partyExternalRef?: { system: string; id: string };
  dimensionBranchId?: string;
  dimensionProjectId?: number;
  dimensionCostCenterId?: string;
}

export interface PostingCommand {
  sourceType: GlJournalSource;
  sourceId: string;
  /**
   * Distinguishes several journals from one source — `post`, `reverse`,
   * `bank_file`. Together with source it forms the idempotency key
   * `{sourceType}:{sourceId}:{purpose}` (M4), so a redelivery is a no-op.
   */
  purpose: string;
  journalDate: string;
  memo?: string;
  lines: PostingCommandLine[];
}

export interface PostingCommandResult {
  journalId: string;
  journalNumber: string;
  replayed: boolean;
}

/**
 * What a payroll run hands over: totals per tag, already computed.
 *
 * Accounting **does not recompute** salary tax. Payroll's numbers are taken as
 * given; a mismatch is a payroll bug and is surfaced as one rather than quietly
 * corrected here (PRD 07 invariant).
 *
 * Summary-level only, never per employee — payslips stay in payroll, which is
 * both a privacy boundary and a volume one (M6).
 */
export interface PayrollRunPosting {
  runId: string;
  /** Accounting date for the run — usually the pay period end. */
  postingDate: string;
  currency: string;
  periodLabel?: string;
  lines: Array<{
    tag: GlSystemTag;
    /** Positive debits the account, negative credits it. */
    amountMinor: number;
    description?: string;
    dimensionBranchId?: string;
  }>;
}

export type AdapterRejectionCode =
  | "UNKNOWN_ACCOUNT_TAG"
  | "UNBALANCED_COMMAND"
  | "BOOK_NOT_ENABLED"
  | "TAX_MISMATCH"
  | "DUPLICATE_DOCUMENT";

/**
 * Configuration an operator can fix, or a disagreement between two modules that
 * a person must settle. All of them are business refusals and answer 409.
 *
 * `UNBALANCED_COMMAND` is deliberately absent. It means the sending module's own
 * totals do not add up, which is a defect in payroll or billing and not
 * something anybody can configure their way out of; dressing it as a 409 would
 * make it look actionable and quietly stop it being investigated. It stays a
 * 500 — but a legible one, carrying the code and the difference.
 */
const BUSINESS_REFUSALS: ReadonlySet<AdapterRejectionCode> = new Set([
  "UNKNOWN_ACCOUNT_TAG",
  /* Should never reach HTTP — every caller swallows it — but a 409 if one forgets. */
  "BOOK_NOT_ENABLED",
  "TAX_MISMATCH",
  "DUPLICATE_DOCUMENT",
]);

/**
 * An `HttpException`, for the same measured reason as `LedgerRejection`.
 *
 * This one had no filter at all, so a missing account mapping on an
 * accounting-enabled tenant answered
 * `500 {"code":"INTERNAL_ERROR","message":"An unexpected error occurred"}` —
 * the operator was told the server broke, and someone was paged for a chart of
 * accounts. Never inventory-specific either: payroll, expenses, billing invoices
 * and AR all funnel through `PostingCommandService`.
 *
 * Writing one was tried first and does not work here: Nest tries global filters
 * in reverse registration order, so `main.ts`'s `useGlobalFilters` catch-all
 * always beats an `APP_FILTER`. Carrying the status on the exception removes the
 * ordering question for every caller, HTTP or not.
 */
export class AdapterRejection extends HttpException {
  constructor(
    readonly code: AdapterRejectionCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    const status = BUSINESS_REFUSALS.has(code)
      ? HttpStatus.CONFLICT
      : HttpStatus.INTERNAL_SERVER_ERROR;
    super(
      {
        statusCode: status,
        error: status === HttpStatus.CONFLICT ? "Conflict" : "Internal Server Error",
        code,
        message,
        ...(details ? { details } : {}),
      },
      status,
    );
    this.name = "AdapterRejection";
  }
}
