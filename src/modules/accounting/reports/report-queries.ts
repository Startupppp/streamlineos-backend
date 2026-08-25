/**
 * The only place `reports/` reads the ledger.
 *
 * Every report in this folder is a projection of `gl_journal_lines` plus open
 * items. **There is no reporting table and there must never be one** — a stored
 * balance is a balance that can disagree with the ledger, and PRD 06's whole
 * position is that a report which can lie is worse than no report. The cost of
 * that decision is that these queries have to be right; the benefit is that
 * "the trial balance does not tie out" becomes unrepresentable.
 */
import { and, asc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  glAccounts,
  glFiscalYears,
  glJournalLines,
  glJournals,
  type GlAccountType,
  type GlSystemTag,
} from "../../../db/schema";
import type { BooksService, BookSummary } from "../kernel/books.service";
import { addDays, assertIsoDate, fiscalYearFor } from "../kernel/fiscal-calendar";
import type { DbOrTx } from "../kernel/sequence.service";

/* ------------------------------------------------------------ book scope */

/**
 * The book a report runs against.
 *
 * An explicit `bookId` goes through `BooksService.get`, which re-asserts the
 * caller's org and answers a cross-tenant id with 404 rather than 403 — a 403
 * would confirm the book exists and turn a probe into an existence oracle
 * (backend/CLAUDE.md §4).
 */
export async function resolveReportBook(
  books: BooksService,
  orgId: string,
  bookId?: string,
): Promise<BookSummary> {
  return bookId ? books.get(orgId, bookId) : books.requireDefault(orgId);
}

/* ------------------------------------------------------------- taxonomy */

/** The five statement classes. Contra types fold into the class they reduce. */
export type AccountClass = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

const CLASS_OF: Readonly<Record<GlAccountType, AccountClass>> = Object.freeze({
  ASSET: "ASSET",
  CONTRA_ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  CONTRA_LIABILITY: "LIABILITY",
  EQUITY: "EQUITY",
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
});

/** Which side a type's balance normally sits on. Contra types invert. */
const DEBIT_NORMAL: Readonly<Record<GlAccountType, boolean>> = Object.freeze({
  ASSET: true,
  CONTRA_ASSET: false,
  LIABILITY: false,
  CONTRA_LIABILITY: true,
  EQUITY: false,
  INCOME: false,
  EXPENSE: true,
});

/** Whether the class as a whole reads debit-positive (assets, expenses). */
const CLASS_DEBIT_POSITIVE: Readonly<Record<AccountClass, boolean>> = Object.freeze({
  ASSET: true,
  EXPENSE: true,
  LIABILITY: false,
  EQUITY: false,
  INCOME: false,
});

export function classOf(accountType: GlAccountType): AccountClass {
  return CLASS_OF[accountType];
}

export function isDebitNormal(accountType: GlAccountType): boolean {
  return DEBIT_NORMAL[accountType];
}

export function isContra(accountType: GlAccountType): boolean {
  return accountType === "CONTRA_ASSET" || accountType === "CONTRA_LIABILITY";
}

/**
 * The account's balance signed **in its own normal direction** — positive for
 * an asset holding a debit, positive for a liability holding a credit.
 */
export function normalSigned(accountType: GlAccountType, debitMinor: number, creditMinor: number) {
  return DEBIT_NORMAL[accountType] ? debitMinor - creditMinor : creditMinor - debitMinor;
}

/**
 * The account's balance signed **in its statement class's direction**, which is
 * how a contra account comes out negative and so reduces its parent class
 * rather than being presented as an asset of its own (PRD 06 M3).
 */
export function classSigned(accountType: GlAccountType, debitMinor: number, creditMinor: number) {
  return CLASS_DEBIT_POSITIVE[CLASS_OF[accountType]]
    ? debitMinor - creditMinor
    : creditMinor - debitMinor;
}

/**
 * Flip a sign without producing `-0`.
 *
 * `-0` compares equal to `0` under `==` and `===` but not under `Object.is`,
 * and it renders as `-0` in a spreadsheet cell. A report that shows a customer
 * owing "-0.00" looks broken even though it is not, so negation goes through
 * here.
 */
export function negated(value: number): number {
  return value === 0 ? 0 : -value;
}

/** Debit minus credit, the raw ledger sign. Sums to zero over a whole book. */
export function ledgerSigned(debitMinor: number, creditMinor: number): number {
  return debitMinor - creditMinor;
}

/* ------------------------------------------------------------- movements */

export interface AccountMovement {
  accountId: string;
  code: string;
  name: string;
  accountType: GlAccountType;
  parentAccountId: string | null;
  isCash: boolean;
  systemTag: GlSystemTag | null;
  /** Functional-currency minor units summed over the requested window. */
  debitMinor: number;
  creditMinor: number;
}

export interface MovementWindow {
  orgId: string;
  bookId: string;
  /** Inclusive. Omit for "since the beginning of the book". */
  from?: string;
  /** Inclusive. Every report is as-of or up-to some date. */
  to: string;
}

/**
 * Per-account debit and credit totals over a window of journal dates.
 *
 * `journal_date` is the accounting date the document supplied, never
 * `posted_at` — backdating a January invoice in March must land in January, and
 * reading `posted_at` here is exactly how a report starts disagreeing with the
 * period it claims to cover.
 *
 * Locked periods are **not** filtered: a locked period is closed to *posting*,
 * not to reading, and a report that went blank at year-end close would be
 * useless precisely when it is needed most.
 */
export async function readAccountMovements(
  db: DbOrTx,
  window: MovementWindow,
): Promise<AccountMovement[]> {
  const to = assertIsoDate(window.to);
  const predicates: SQL[] = [
    eq(glJournalLines.orgId, window.orgId),
    eq(glJournalLines.bookId, window.bookId),
    lte(glJournals.journalDate, to),
  ];
  if (window.from) predicates.push(gte(glJournals.journalDate, assertIsoDate(window.from)));

  const rows = await db
    .select({
      accountId: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      parentAccountId: glAccounts.parentAccountId,
      isCash: glAccounts.isCash,
      systemTag: glAccounts.systemTag,
      debitMinor: sql<string>`coalesce(sum(${glJournalLines.debitMinor}), 0)::bigint`,
      creditMinor: sql<string>`coalesce(sum(${glJournalLines.creditMinor}), 0)::bigint`,
    })
    .from(glJournalLines)
    .innerJoin(glAccounts, eq(glJournalLines.accountId, glAccounts.id))
    .innerJoin(glJournals, eq(glJournalLines.journalId, glJournals.id))
    .where(and(...predicates))
    .groupBy(
      glAccounts.id,
      glAccounts.code,
      glAccounts.name,
      glAccounts.accountType,
      glAccounts.parentAccountId,
      glAccounts.isCash,
      glAccounts.systemTag,
    )
    .orderBy(asc(glAccounts.code));

  return rows.map((r) => ({
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    accountType: r.accountType,
    parentAccountId: r.parentAccountId,
    isCash: r.isCash,
    systemTag: r.systemTag,
    debitMinor: Number(r.debitMinor),
    creditMinor: Number(r.creditMinor),
  }));
}

/** Every posting account in the book, including ones nothing has touched. */
export async function readPostingAccounts(
  db: DbOrTx,
  bookId: string,
): Promise<Omit<AccountMovement, "debitMinor" | "creditMinor">[]> {
  return db
    .select({
      accountId: glAccounts.id,
      code: glAccounts.code,
      name: glAccounts.name,
      accountType: glAccounts.accountType,
      parentAccountId: glAccounts.parentAccountId,
      isCash: glAccounts.isCash,
      systemTag: glAccounts.systemTag,
    })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.isHeader, false),
        eq(glAccounts.isActive, true),
        isNull(glAccounts.deletedAt),
      ),
    )
    .orderBy(asc(glAccounts.code));
}

/**
 * Movements keyed by account id, with zero-activity accounts optionally filled
 * in so a report can offer "show accounts with no activity" without a second
 * shape of row.
 */
export async function readAccountMovementsWithZeros(
  db: DbOrTx,
  window: MovementWindow,
  includeZeroActivity: boolean,
): Promise<AccountMovement[]> {
  const active = await readAccountMovements(db, window);
  if (!includeZeroActivity) return active;

  const seen = new Set(active.map((a) => a.accountId));
  const all = await readPostingAccounts(db, window.bookId);
  const filled = all
    .filter((a) => !seen.has(a.accountId))
    .map((a) => ({ ...a, debitMinor: 0, creditMinor: 0 }));

  return [...active, ...filled].sort((a, b) => a.code.localeCompare(b.code));
}

/** Total of the `is_cash` accounts as of a date, in functional minor units. */
export function cashBalanceOf(movements: readonly AccountMovement[]): number {
  return movements
    .filter((m) => m.isCash)
    .reduce((total, m) => total + ledgerSigned(m.debitMinor, m.creditMinor), 0);
}

/** Income minus expense over whatever window produced `movements`. */
export function profitOf(movements: readonly AccountMovement[]): number {
  let income = 0;
  let expense = 0;
  for (const m of movements) {
    const klass = classOf(m.accountType);
    if (klass === "INCOME") income += classSigned(m.accountType, m.debitMinor, m.creditMinor);
    if (klass === "EXPENSE") expense += classSigned(m.accountType, m.debitMinor, m.creditMinor);
  }
  return income - expense;
}

/* ---------------------------------------------------------- fiscal years */

export interface FiscalYearWindow {
  name: string;
  startsOn: string;
  endsOn: string;
  /** False when no `gl_fiscal_years` row covers the date and we derived it. */
  opened: boolean;
}

/**
 * The fiscal year containing `date`.
 *
 * Prefers the opened `gl_fiscal_years` row, because that is what postings were
 * actually filed against. Falls back to deriving the span from the book's
 * calendar so a report for a date whose year was never opened still answers —
 * a founder asking for last year's P&L before anyone pressed "open year"
 * deserves a number, not a 404.
 */
export async function fiscalYearWindowFor(
  db: DbOrTx,
  book: { id: string; fiscalYearStartMonth: number; fiscalYearStartDay: number },
  date: string,
): Promise<FiscalYearWindow> {
  const on = assertIsoDate(date);
  const [row] = await db
    .select({
      name: glFiscalYears.name,
      startsOn: glFiscalYears.startsOn,
      endsOn: glFiscalYears.endsOn,
    })
    .from(glFiscalYears)
    .where(
      and(
        eq(glFiscalYears.bookId, book.id),
        lte(glFiscalYears.startsOn, on),
        gte(glFiscalYears.endsOn, on),
      ),
    )
    .limit(1);

  if (row) return { ...row, opened: true };

  const derived = fiscalYearFor(
    on,
    book.fiscalYearStartMonth,
    book.fiscalYearStartDay,
    book.fiscalYearStartMonth === 1 && book.fiscalYearStartDay === 1 ? "calendar" : "span",
  );
  return { ...derived, opened: false };
}

/** The day before a date, for "opening balance" reads. */
export function dayBefore(date: string): string {
  return addDays(assertIsoDate(date), -1);
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `from` to `to`, positive when `to` is later.
 *
 * Parsed as UTC midnights, never local — a server in `Asia/Kolkata` computing
 * an ageing bucket from a `Date` built in local time drifts by a day either
 * side of DST, and an invoice landing in `31-60` instead of `0-30` is a
 * collections call to a customer who is not late.
 */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = assertIsoDate(from).split("-").map(Number);
  const [ty, tm, td] = assertIsoDate(to).split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY);
}
