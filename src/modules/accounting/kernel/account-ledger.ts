/**
 * The drill-to-source query — PRD 09 §L.
 *
 * Lives beside `AccountsService` rather than inside it because it is one read
 * with one non-obvious trick in it, and the chart-of-accounts service is about
 * configuration rather than reporting.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import {
  glJournalLines,
  glJournals,
  type GlAccountType,
  type GlJournalSource,
} from "../../../db/schema";
import type { DbOrTx } from "./sequence.service";

export interface AccountBalance {
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

/**
 * One posting on one account, with the document that caused it.
 *
 * `sourceType` + `sourceId` are what turn a report figure into a link back to
 * the invoice or bill behind it — without them a reader can see the number and
 * never find out why.
 */
export interface AccountLedgerEntry {
  lineId: string;
  lineNo: number;
  journalId: string;
  journalNumber: string;
  journalDate: string;
  memo: string | null;
  description: string | null;
  debitMinor: number;
  creditMinor: number;
  runningBalanceMinor: number;
  sourceType: GlJournalSource;
  sourceId: string | null;
}

export interface AccountLedgerPage {
  accountId: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  from: string;
  to: string;
  /** Carried into the window — everything dated strictly before `from`. */
  opening: AccountBalance;
  periodDebitMinor: number;
  periodCreditMinor: number;
  closingBalanceMinor: number;
  entries: AccountLedgerEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AccountLedgerQuery {
  from: string;
  to: string;
  page: number;
  pageSize: number;
}

/** Hard cap, per backend/CLAUDE.md §3. */
export const MAX_LEDGER_PAGE_SIZE = 100;

interface LedgerScope {
  orgId: string;
  bookId: string;
  account: { id: string; code: string; name: string; accountType: GlAccountType };
  from: string;
  to: string;
}

/**
 * Every posting on one account across a window, in ledger order, each row
 * carrying the balance the account stood at once that row had been applied.
 *
 * The running balance is a window function over the **whole** window, not the
 * page, so row 1 of page 2 continues where page 1 stopped. Computing it in the
 * client from the page alone would restart at zero on every page and quietly
 * disagree with the report the reader drilled in from.
 */
export async function readAccountLedger(
  db: DbOrTx,
  scope: LedgerScope,
  query: AccountLedgerQuery,
  opening: AccountBalance,
): Promise<AccountLedgerPage> {
  const pageSize = Math.min(query.pageSize, MAX_LEDGER_PAGE_SIZE);
  const offset = (query.page - 1) * pageSize;
  const inWindow = and(
    eq(glJournalLines.orgId, scope.orgId),
    eq(glJournalLines.bookId, scope.bookId),
    eq(glJournalLines.accountId, scope.account.id),
    gte(glJournals.journalDate, scope.from),
    lte(glJournals.journalDate, scope.to),
  );

  const [totals] = await db
    .select({
      total: sql<string>`count(*)`,
      debitMinor: sql<string>`coalesce(sum(${glJournalLines.debitMinor}), 0)`,
      creditMinor: sql<string>`coalesce(sum(${glJournalLines.creditMinor}), 0)`,
    })
    .from(glJournalLines)
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(inWindow);

  const rows = await db
    .select({
      lineId: glJournalLines.id,
      lineNo: glJournalLines.lineNo,
      journalId: glJournals.id,
      journalNumber: glJournals.journalNumber,
      journalDate: glJournals.journalDate,
      memo: glJournals.memo,
      description: glJournalLines.description,
      debitMinor: glJournalLines.debitMinor,
      creditMinor: glJournalLines.creditMinor,
      sourceType: glJournals.sourceType,
      sourceId: glJournals.sourceId,
      // Evaluated across the whole filtered set before LIMIT/OFFSET, which is
      // exactly what makes it correct on page two.
      runningDeltaMinor: sql<string>`sum(${glJournalLines.debitMinor} - ${glJournalLines.creditMinor}) over (order by ${glJournals.journalDate}, ${glJournals.journalNumber}, ${glJournalLines.lineNo} rows between unbounded preceding and current row)`,
    })
    .from(glJournalLines)
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(inWindow)
    .orderBy(asc(glJournals.journalDate), asc(glJournals.journalNumber), asc(glJournalLines.lineNo))
    .limit(pageSize)
    .offset(offset);

  const periodDebitMinor = Number(totals?.debitMinor ?? 0);
  const periodCreditMinor = Number(totals?.creditMinor ?? 0);

  return {
    accountId: scope.account.id,
    code: scope.account.code,
    name: scope.account.name,
    accountType: scope.account.accountType,
    from: scope.from,
    to: scope.to,
    opening,
    periodDebitMinor,
    periodCreditMinor,
    closingBalanceMinor: opening.balanceMinor + periodDebitMinor - periodCreditMinor,
    entries: rows.map(({ runningDeltaMinor, ...entry }) => ({
      ...entry,
      runningBalanceMinor: opening.balanceMinor + Number(runningDeltaMinor),
    })),
    page: query.page,
    pageSize,
    total: Number(totals?.total ?? 0),
  };
}
