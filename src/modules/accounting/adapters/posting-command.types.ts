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

/** A billing invoice offered to accounting, identified by its own id. */
export interface BillingInvoicePosting {
  externalSystem: string;
  externalId: string;
  partyExternalRef?: { system: string; id: string };
  partyName: string;
  issueDate: string;
  dueDate?: string;
  currency: string;
  lines: Array<{
    description: string;
    quantityMilli?: number;
    unitPriceMinor: number;
    /** If billing already computed tax, accounting compares rather than trusts. */
    expectedTaxMinor?: number;
  }>;
  expectedTotalMinor?: number;
}

export class AdapterRejection extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_ACCOUNT_TAG"
      | "UNBALANCED_COMMAND"
      | "BOOK_NOT_ENABLED"
      | "TAX_MISMATCH"
      | "DUPLICATE_DOCUMENT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdapterRejection";
  }
}
