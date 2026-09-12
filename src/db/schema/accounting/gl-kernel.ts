/**
 * Ledger kernel — the accounting bounded context's posting engine.
 *
 * Money is **integer minor units** (`bigint`, mode "number", following the
 * `crm.deals.value_minor` precedent) plus an explicit ISO-4217 code. Never a
 * decimal, never a float. `Number.MAX_SAFE_INTEGER` minor units is ~9e13 major
 * units, far beyond any tenant; `assertSafeMinor` in the domain layer and the
 * CHECK constraints below hold the floor.
 *
 * Journals are append-only. A correction is a reversing journal, never an
 * UPDATE. See `01-prd-ledger-kernel.md`.
 *
 * This file declares the ledger itself — `gl_journals` and `gl_journal_lines` —
 * and is one of the two files `ledger-boundary.spec.ts` allows to name them in a
 * write position. The configuration they post against lives beside it and is
 * re-exported from here, so every name this file ever exported still is:
 *
 *   gl-enums.ts               account types, states, journal sources, system tags
 *   gl-books.ts               books, currencies, book currencies, FX rates
 *   gl-chart-and-calendar.ts  accounts, fiscal years, periods, document sequences
 */
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { projects } from "../build";
import { glJournalSourceEnum } from "./gl-enums";
import { glBooks, glFxRates } from "./gl-books";
import { glAccounts, glFiscalYears, glPeriods } from "./gl-chart-and-calendar";

export * from "./gl-enums";
export * from "./gl-books";
export * from "./gl-chart-and-calendar";

/* --------------------------------------------------------------- journals */

export const glJournals = pgTable(
  "gl_journals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => glBooks.id, { onDelete: "cascade" }),
    periodId: text("period_id")
      .notNull()
      .references(() => glPeriods.id, { onDelete: "restrict" }),

    /** Human handle, e.g. `JV/2026-27/000123`. Unique per book. */
    journalNumber: text("journal_number").notNull(),
    /** Accounting date, supplied by the document — never `posted_at`. */
    journalDate: date("journal_date").notNull(),
    memo: text("memo"),

    sourceType: glJournalSourceEnum("source_type").notNull(),
    sourceId: text("source_id"),

    /**
     * Caller-supplied, required. `(book_id, idempotency_key)` is unique, so a
     * double-submit returns the original journal instead of posting twice (M8).
     */
    idempotencyKey: text("idempotency_key").notNull(),

    reversesJournalId: text("reverses_journal_id").references(
      (): AnyPgColumn => glJournals.id,
      { onDelete: "restrict" },
    ),
    reversedByJournalId: text("reversed_by_journal_id").references(
      (): AnyPgColumn => glJournals.id,
      { onDelete: "restrict" },
    ),

    postedByUserId: text("posted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_gl_journals_org_id").on(t.orgId, t.id),
    unique("uniq_gl_journals_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_gl_journals_book_idempotency").on(t.bookId, t.idempotencyKey),
    uniqueIndex("uniq_gl_journals_book_number").on(t.bookId, t.journalNumber),
    /** A journal is reversed at most once (invariant 5). */
    uniqueIndex("uniq_gl_journals_reverses").on(t.reversesJournalId).where(sql`reverses_journal_id IS NOT NULL`),
    uniqueIndex("uniq_gl_journals_reversed_by")
      .on(t.reversedByJournalId)
      .where(sql`reversed_by_journal_id IS NOT NULL`),
    index("idx_gl_journals_book_date").on(t.bookId, t.journalDate),
    index("idx_gl_journals_org_book_date").on(t.orgId, t.bookId, t.journalDate),
    index("idx_gl_journals_source").on(t.bookId, t.sourceType, t.sourceId),
    index("idx_gl_journals_period").on(t.periodId),
  ],
);

export const glJournalLines = pgTable(
  "gl_journal_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => glBooks.id, { onDelete: "cascade" }),
    journalId: text("journal_id")
      .notNull()
      .references(() => glJournals.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),

    /** Exactly one of these is > 0. Both are functional-currency minor units. */
    debitMinor: bigint("debit_minor", { mode: "number" }).notNull().default(0),
    creditMinor: bigint("credit_minor", { mode: "number" }).notNull().default(0),

    /** What the document said. */
    txnCurrency: text("txn_currency").notNull(),
    txnAmountMinor: bigint("txn_amount_minor", { mode: "number" }).notNull(),

    /** What the books say. Always the book's base currency (invariant 3). */
    functionalCurrency: text("functional_currency").notNull(),
    functionalAmountMinor: bigint("functional_amount_minor", { mode: "number" }).notNull(),

    /** Snapshot, never re-read from `gl_fx_rates` (invariant: posted rates freeze). */
    fxRate: numeric("fx_rate", { precision: 18, scale: 10 }).notNull().default("1"),
    fxRateId: text("fx_rate_id").references(() => glFxRates.id, { onDelete: "set null" }),

    /** Filled by documents; null for plain manual journals. */
    partyId: text("party_id"),
    taxCodeId: text("tax_code_id"),
    taxComponent: text("tax_component"),

    dimensionBranchId: text("dimension_branch_id").references(() => orgUnits.id, {
      onDelete: "set null",
    }),
    dimensionProjectId: integer("dimension_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    dimensionCostCenterId: text("dimension_cost_center_id"),
    dimensionValues: jsonb("dimension_values").$type<Record<string, string>>(),

    description: text("description"),
  },
  (t) => [
    unique("uniq_gl_journal_lines_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_gl_journal_lines_journal_line_no").on(t.journalId, t.lineNo),
    /** The trial-balance and ledger access path. */
    index("idx_gl_journal_lines_book_account").on(t.bookId, t.accountId),
    index("idx_gl_journal_lines_org_book_account").on(t.orgId, t.bookId, t.accountId),
    index("idx_gl_journal_lines_journal").on(t.journalId),
    index("idx_gl_journal_lines_book_party").on(t.bookId, t.partyId),
    index("idx_gl_journal_lines_book_tax_code").on(t.bookId, t.taxCodeId),
    index("idx_gl_journal_lines_book_project").on(t.bookId, t.dimensionProjectId),
    index("idx_gl_journal_lines_book_branch").on(t.bookId, t.dimensionBranchId),

    /* The kernel's invariants, enforced by the database as well as the service. */
    check("ck_gl_journal_lines_one_side", sql`(debit_minor = 0) <> (credit_minor = 0)`),
    check("ck_gl_journal_lines_non_negative", sql`debit_minor >= 0 AND credit_minor >= 0`),
    check("ck_gl_journal_lines_txn_positive", sql`txn_amount_minor > 0`),
    check("ck_gl_journal_lines_functional_positive", sql`functional_amount_minor > 0`),
    check(
      "ck_gl_journal_lines_functional_matches_side",
      sql`functional_amount_minor = GREATEST(debit_minor, credit_minor)`,
    ),
    check("ck_gl_journal_lines_fx_positive", sql`fx_rate > 0`),
    check(
      "ck_gl_journal_lines_same_ccy_rate_one",
      sql`txn_currency <> functional_currency OR fx_rate = 1`,
    ),
  ],
);

/* ------------------------------------------------------------- relations */

/*
  The account and period relations are declared here rather than beside their
  tables because each names a ledger table, and moving them out would make
  `gl-chart-and-calendar.ts` import this file back.
*/
export const glAccountsRelations = relations(glAccounts, ({ one, many }) => ({
  book: one(glBooks, { fields: [glAccounts.bookId], references: [glBooks.id] }),
  parent: one(glAccounts, {
    fields: [glAccounts.parentAccountId],
    references: [glAccounts.id],
    relationName: "gl_account_parent",
  }),
  children: many(glAccounts, { relationName: "gl_account_parent" }),
  lines: many(glJournalLines),
}));

export const glPeriodsRelations = relations(glPeriods, ({ one, many }) => ({
  book: one(glBooks, { fields: [glPeriods.bookId], references: [glBooks.id] }),
  fiscalYear: one(glFiscalYears, {
    fields: [glPeriods.fiscalYearId],
    references: [glFiscalYears.id],
  }),
  journals: many(glJournals),
}));

export const glJournalsRelations = relations(glJournals, ({ one, many }) => ({
  book: one(glBooks, { fields: [glJournals.bookId], references: [glBooks.id] }),
  period: one(glPeriods, { fields: [glJournals.periodId], references: [glPeriods.id] }),
  postedBy: one(users, {
    fields: [glJournals.postedByUserId],
    references: [users.id],
    relationName: "gl_journal_posted_by",
  }),
  reverses: one(glJournals, {
    fields: [glJournals.reversesJournalId],
    references: [glJournals.id],
    relationName: "gl_journal_reversal",
  }),
  lines: many(glJournalLines),
}));

export const glJournalLinesRelations = relations(glJournalLines, ({ one }) => ({
  journal: one(glJournals, { fields: [glJournalLines.journalId], references: [glJournals.id] }),
  account: one(glAccounts, { fields: [glJournalLines.accountId], references: [glAccounts.id] }),
  book: one(glBooks, { fields: [glJournalLines.bookId], references: [glBooks.id] }),
}));

/* ----------------------------------------------------------------- types */

export type GlJournal = typeof glJournals.$inferSelect;
export type GlJournalLine = typeof glJournalLines.$inferSelect;
export type NewGlJournalLine = typeof glJournalLines.$inferInsert;
