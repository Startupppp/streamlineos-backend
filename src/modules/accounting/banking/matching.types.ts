/**
 * The shapes `MatchingService` reads and returns: a statement line in its bank
 * account's context, a suggested or recorded match, and the two halves of the
 * unreconciled view. `matching.service.ts` re-exports every one of them.
 */
import type { BankAccountSummary } from "./bank-accounts.service";

export type MatchKind = "receipt" | "payment" | "journal";

export interface MatchCounterpart {
  kind: MatchKind;
  id: string;
}

export interface StatementLineContext {
  id: string;
  statementId: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
  profile: BankAccountSummary;
  periodStart: string;
  periodEnd: string;
}

export interface MatchSuggestion {
  kind: MatchKind;
  id: string;
  label: string;
  date: string;
  /** Signed, in the bank account's currency. Positive is money in. */
  amountMinor: number;
  currency: string;
  reference: string | null;
  score: number;
  reasons: string[];
  /** The text the similarity boost reads. Internal to the scoring rules. */
  searchText?: string;
}

export interface RecordedMatch {
  id: string;
  statementLineId: string;
  kind: MatchKind;
  counterpartId: string;
  amountMinor: number;
  currency: string;
  matchedAt: Date;
}

export interface UnreconciledGlLine {
  journalId: string;
  journalNumber: string;
  journalDate: string;
  lineId: string;
  lineNo: number;
  accountId: string;
  /** Signed, in the bank account's currency. */
  amountMinor: number;
  txnCurrency: string;
  functionalAmountMinor: number;
  memo: string | null;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
}

export interface UnreconciledStatementLine {
  id: string;
  statementId: string;
  lineNo: number;
  valueDate: string;
  amountMinor: number;
  description: string | null;
  bankReference: string | null;
}

export interface UnreconciledView {
  bookId: string;
  accountId: string;
  bankProfileId: string;
  currency: string;
  asOf: string;
  statementLines: UnreconciledStatementLine[];
  statementLinesTotalMinor: number;
  glLines: UnreconciledGlLine[];
  glLinesTotalMinor: number;
  page: number;
  pageSize: number;
}
