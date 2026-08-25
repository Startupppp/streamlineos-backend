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
 */
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { legalEntities } from "../common/legal-entities";
import { orgUnits } from "../common/organization";
import { projects } from "../build";

/* ------------------------------------------------------------------ enums */

/** Normal balance is derived from the type; contra types invert their parent. */
export const glAccountTypeEnum = pgEnum("gl_account_type", [
  "ASSET",
  "CONTRA_ASSET",
  "LIABILITY",
  "CONTRA_LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
]);

export const glPeriodStatusEnum = pgEnum("gl_period_status", ["OPEN", "LOCKED"]);

export const glFiscalYearStatusEnum = pgEnum("gl_fiscal_year_status", ["OPEN", "CLOSED"]);

export const glBookStatusEnum = pgEnum("gl_book_status", ["ACTIVE", "ARCHIVED"]);

/**
 * Source of a posting. Documents are sources; the kernel never invents one.
 * PRD 07 M3 fixes this list — adding a member is an accounting-side change only.
 */
export const glJournalSourceEnum = pgEnum("gl_journal_source", [
  "manual",
  "opening_balance",
  "sales_invoice",
  "credit_note",
  "receipt",
  "purchase_bill",
  "debit_note",
  "payment",
  "bank_fee",
  "bank_transfer",
  "payroll_run",
  "expense_claim",
  "billing_invoice",
  "withholding",
  "fx_reval",
  "depreciation",
  "stock_move",
  "period_close",
]);

/**
 * Stable roles documents resolve accounts by, so no document hardcodes a code.
 * Packs (PRD 12) tag their seeded chart against these.
 */
export const glSystemTagEnum = pgEnum("gl_system_tag", [
  "cash",
  "bank",
  "undeposited",
  "ar_control",
  "ap_control",
  "sales",
  "other_income",
  "cogs",
  "opex",
  "salary",
  "equity_capital",
  "retained_earnings",
  "current_year_earnings",
  "fx_gain",
  "fx_loss",
  "rounding",
  // generic tax
  "vat_input",
  "vat_output",
  "sales_tax_payable",
  "wht_payable",
  // India GST pack
  "gst_input_cgst",
  "gst_input_sgst",
  "gst_input_igst",
  "gst_input_utgst",
  "gst_input_cess",
  "gst_output_cgst",
  "gst_output_sgst",
  "gst_output_igst",
  "gst_output_utgst",
  "gst_output_cess",
  // payment rails (PRD 14) — clearing only, never a bank
  "psp_clearing",
  "razorpay_clearing",
  "stripe_clearing",
  "payment_fees",
  // payroll hand-off (PRD 07)
  "net_pay_clearing",
  "statutory_payable",
  // reserved for PRD 15 so v2 does not migrate posted history
  "fixed_asset",
  "accum_depreciation",
  "depreciation_expense",
  "deferred_revenue",
  "inventory",
]);

/* ------------------------------------------------------------------ books */

/**
 * A **book** is the set of books for one legal entity. The platform already
 * owns `legal_entities` (HR/payroll use it); this is the accounting-side
 * configuration hung off it, so "one identity" still holds for the company.
 * v1 creates exactly one book per org; the schema allows N.
 */
export const glBooks = pgTable(
  "gl_books",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    legalEntityId: text("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "restrict",
    }),

    name: text("name").notNull(),
    countryCode: text("country_code").notNull(),
    /** Functional currency. Every journal line balances in this. */
    baseCurrency: text("base_currency").notNull(),
    /** Localization pack code — `IN`, `US`, `GENERIC_VAT`, … (PRD 12). */
    localizationPack: text("localization_pack").notNull(),

    /** Fiscal calendar as data, not code (A8). India 4/1, most others 1/1. */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(4),
    fiscalYearStartDay: integer("fiscal_year_start_day").notNull().default(1),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),

    /** Multi-entity later (PRD 12); null in v1. */
    parentBookId: text("parent_book_id").references((): AnyPgColumn => glBooks.id, {
      onDelete: "set null",
    }),

    isDefault: boolean("is_default").notNull().default(true),
    status: glBookStatusEnum("status").notNull().default("ACTIVE"),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    unique("uniq_gl_books_org_id").on(t.orgId, t.id),
    index("idx_gl_books_org_status").on(t.orgId, t.status),
    uniqueIndex("uniq_gl_books_org_default")
      .on(t.orgId)
      .where(sql`is_default = true AND deleted_at IS NULL`),
    check("ck_gl_books_fy_month", sql`fiscal_year_start_month BETWEEN 1 AND 12`),
    check("ck_gl_books_fy_day", sql`fiscal_year_start_day BETWEEN 1 AND 28`),
    check("ck_gl_books_base_currency", sql`base_currency ~ '^[A-Z]{3}$'`),
  ],
);

/* ------------------------------------------------------- currency and FX */

/**
 * ISO 4217 catalog. Global, not tenant-scoped — a currency's minor-unit scale
 * is a fact about the world (JPY 0, INR/USD 2, KWD 3), not about an org.
 */
export const glCurrencies = pgTable(
  "gl_currencies",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    minorUnits: integer("minor_units").notNull(),
    symbol: text("symbol"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    check("ck_gl_currencies_code", sql`code ~ '^[A-Z]{3}$'`),
    check("ck_gl_currencies_minor_units", sql`minor_units BETWEEN 0 AND 4`),
  ],
);

/** Currencies a book may transact in. Exactly one row per book is the base. */
export const glBookCurrencies = pgTable(
  "gl_book_currencies",
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
    currencyCode: text("currency_code")
      .notNull()
      .references(() => glCurrencies.code, { onDelete: "restrict" }),
    isBase: boolean("is_base").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_gl_book_currencies_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_gl_book_currencies_book_code").on(t.bookId, t.currencyCode),
    uniqueIndex("uniq_gl_book_currencies_base").on(t.bookId).where(sql`is_base = true`),
    index("idx_gl_book_currencies_org_book").on(t.orgId, t.bookId),
  ],
);

/**
 * `rate` is a **multiplier from transaction currency to functional currency**:
 * `functional = txn * rate`, scale-adjusted. Fixed direction, documented once,
 * tested in `money.spec.ts`. Stored `numeric(18,10)` — never a float.
 */
export const glFxRates = pgTable(
  "gl_fx_rates",
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
    fromCode: text("from_code").notNull(),
    toCode: text("to_code").notNull(),
    rateDate: date("rate_date").notNull(),
    rate: numeric("rate", { precision: 18, scale: 10 }).notNull(),
    source: text("source").notNull().default("manual"),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("uniq_gl_fx_rates_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_gl_fx_rates_book_pair_date").on(t.bookId, t.fromCode, t.toCode, t.rateDate),
    index("idx_gl_fx_rates_org_book_date").on(t.orgId, t.bookId, t.rateDate),
    check("ck_gl_fx_rates_positive", sql`rate > 0`),
    check("ck_gl_fx_rates_distinct", sql`from_code <> to_code`),
  ],
);

/* --------------------------------------------------- chart of accounts */

export const glAccounts = pgTable(
  "gl_accounts",
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

    code: text("code").notNull(),
    name: text("name").notNull(),
    accountType: glAccountTypeEnum("account_type").notNull(),
    parentAccountId: text("parent_account_id").references((): AnyPgColumn => glAccounts.id, {
      onDelete: "restrict",
    }),

    /** Header accounts group; they never receive a posting (M4). */
    isHeader: boolean("is_header").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** Bank and cash accounts *are* GL accounts (PRD 04 M1). */
    isCash: boolean("is_cash").notNull().default(false),
    /** Seeded by the pack so documents resolve by role, not by code (S3). */
    systemTag: glSystemTagEnum("system_tag"),
    /** Null = any currency may post here. */
    currencyRestriction: text("currency_restriction"),

    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    unique("uniq_gl_accounts_org_id").on(t.orgId, t.id),
    unique("uniq_gl_accounts_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_gl_accounts_book_code")
      .on(t.bookId, t.code)
      .where(sql`deleted_at IS NULL`),
    /** One account per role per book, so `resolveByTag` is unambiguous. */
    uniqueIndex("uniq_gl_accounts_book_system_tag")
      .on(t.bookId, t.systemTag)
      .where(sql`system_tag IS NOT NULL AND deleted_at IS NULL`),
    index("idx_gl_accounts_org_book_type")
      .on(t.orgId, t.bookId, t.accountType)
      .where(sql`deleted_at IS NULL`),
    index("idx_gl_accounts_book_cash")
      .on(t.bookId)
      .where(sql`is_cash = true AND deleted_at IS NULL`),
    index("idx_gl_accounts_book_parent").on(t.bookId, t.parentAccountId),
    check("ck_gl_accounts_header_not_cash", sql`NOT (is_header AND is_cash)`),
  ],
);

/* -------------------------------------------------- fiscal years, periods */

export const glFiscalYears = pgTable(
  "gl_fiscal_years",
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

    /** Pack-formatted label — India `2026-27`, calendar packs `2026`. */
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: glFiscalYearStatusEnum("status").notNull().default("OPEN"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_gl_fiscal_years_org_id").on(t.orgId, t.id),
    unique("uniq_gl_fiscal_years_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_gl_fiscal_years_book_name").on(t.bookId, t.name),
    uniqueIndex("uniq_gl_fiscal_years_book_start").on(t.bookId, t.startsOn),
    index("idx_gl_fiscal_years_org_book").on(t.orgId, t.bookId),
    check("ck_gl_fiscal_years_range", sql`ends_on > starts_on`),
  ],
);

export const glPeriods = pgTable(
  "gl_periods",
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
    fiscalYearId: text("fiscal_year_id")
      .notNull()
      .references(() => glFiscalYears.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    sequence: integer("sequence").notNull(),
    status: glPeriodStatusEnum("status").notNull().default("OPEN"),

    lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
    lockedAt: timestamp("locked_at"),
    lockReason: text("lock_reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_gl_periods_org_id").on(t.orgId, t.id),
    unique("uniq_gl_periods_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_gl_periods_fy_sequence").on(t.fiscalYearId, t.sequence),
    /** The date→period lookup on every post; must be unambiguous and fast. */
    uniqueIndex("uniq_gl_periods_book_start").on(t.bookId, t.startsOn),
    index("idx_gl_periods_book_range").on(t.bookId, t.startsOn, t.endsOn),
    index("idx_gl_periods_org_book_status").on(t.orgId, t.bookId, t.status),
    check("ck_gl_periods_range", sql`ends_on >= starts_on`),
  ],
);

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

/* -------------------------------------------------------------- sequences */

/**
 * Numbering for journals and every tax document, allocated by an atomic
 * `next_number = next_number + 1` upsert so two concurrent posts cannot collide.
 *
 * A rolled-back transaction leaves a gap. That is correct for journals (PRD 01
 * M12 does not require gapless) and accepted for documents: a tax authority
 * cares that a number is never *reused*, which the unique index guarantees.
 * `fiscal_year_id` is null for packs whose series runs continuously.
 */
export const glDocumentSequences = pgTable(
  "gl_document_sequences",
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
    /** A `DocumentSeriesKind` from the pack — `journal`, `salesInvoice`, … */
    kind: text("kind").notNull(),
    fiscalYearId: text("fiscal_year_id").references(() => glFiscalYears.id, {
      onDelete: "cascade",
    }),

    prefix: text("prefix").notNull(),
    pattern: text("pattern").notNull(),
    padding: integer("padding").notNull().default(4),
    nextNumber: integer("next_number").notNull().default(1),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_gl_document_sequences_org_id").on(t.orgId, t.id),
    /**
     * Two partial uniques rather than one: Postgres treats NULLs as distinct,
     * so a plain composite would let a continuous series be created twice.
     */
    uniqueIndex("uniq_gl_document_sequences_book_kind_fy")
      .on(t.bookId, t.kind, t.fiscalYearId)
      .where(sql`fiscal_year_id IS NOT NULL`),
    uniqueIndex("uniq_gl_document_sequences_book_kind")
      .on(t.bookId, t.kind)
      .where(sql`fiscal_year_id IS NULL`),
    index("idx_gl_document_sequences_org_book").on(t.orgId, t.bookId),
    check("ck_gl_document_sequences_next", sql`next_number >= 1`),
    check("ck_gl_document_sequences_padding", sql`padding BETWEEN 1 AND 12`),
  ],
);

/* ------------------------------------------------------------- relations */

export const glDocumentSequencesRelations = relations(glDocumentSequences, ({ one }) => ({
  book: one(glBooks, { fields: [glDocumentSequences.bookId], references: [glBooks.id] }),
  fiscalYear: one(glFiscalYears, {
    fields: [glDocumentSequences.fiscalYearId],
    references: [glFiscalYears.id],
  }),
}));

export const glBooksRelations = relations(glBooks, ({ one, many }) => ({
  organization: one(organizations, { fields: [glBooks.orgId], references: [organizations.id] }),
  legalEntity: one(legalEntities, {
    fields: [glBooks.legalEntityId],
    references: [legalEntities.id],
  }),
  parent: one(glBooks, {
    fields: [glBooks.parentBookId],
    references: [glBooks.id],
    relationName: "gl_book_parent",
  }),
  children: many(glBooks, { relationName: "gl_book_parent" }),
  accounts: many(glAccounts),
  fiscalYears: many(glFiscalYears),
  currencies: many(glBookCurrencies),
}));

export const glBookCurrenciesRelations = relations(glBookCurrencies, ({ one }) => ({
  book: one(glBooks, { fields: [glBookCurrencies.bookId], references: [glBooks.id] }),
  currency: one(glCurrencies, {
    fields: [glBookCurrencies.currencyCode],
    references: [glCurrencies.code],
  }),
}));

export const glFxRatesRelations = relations(glFxRates, ({ one }) => ({
  book: one(glBooks, { fields: [glFxRates.bookId], references: [glBooks.id] }),
}));

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

export const glFiscalYearsRelations = relations(glFiscalYears, ({ one, many }) => ({
  book: one(glBooks, { fields: [glFiscalYears.bookId], references: [glBooks.id] }),
  periods: many(glPeriods),
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

export type GlBook = typeof glBooks.$inferSelect;
export type GlAccount = typeof glAccounts.$inferSelect;
export type GlFiscalYear = typeof glFiscalYears.$inferSelect;
export type GlPeriod = typeof glPeriods.$inferSelect;
export type GlJournal = typeof glJournals.$inferSelect;
export type GlJournalLine = typeof glJournalLines.$inferSelect;
export type NewGlJournalLine = typeof glJournalLines.$inferInsert;
export type GlAccountType = (typeof glAccountTypeEnum.enumValues)[number];
export type GlSystemTag = (typeof glSystemTagEnum.enumValues)[number];
export type GlJournalSource = (typeof glJournalSourceEnum.enumValues)[number];
