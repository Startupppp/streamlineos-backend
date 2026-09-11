/**
 * The chart of accounts, and the fiscal calendar and numbering series a book
 * posts into.
 *
 * Split out of `gl-kernel.ts`, which re-exports every name here.
 * `glAccountsRelations` and `glPeriodsRelations` stay in `gl-kernel.ts`: each
 * names a ledger table, and the ledger tables are declared there and nowhere
 * else (`ledger-boundary.spec.ts`).
 */
import {
  boolean,
  check,
  date,
  index,
  integer,
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
import {
  glAccountTypeEnum,
  glFiscalYearStatusEnum,
  glPeriodStatusEnum,
  glSystemTagEnum,
} from "./gl-enums";
import { glBookCurrencies, glBooks } from "./gl-books";

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

export const glFiscalYearsRelations = relations(glFiscalYears, ({ one, many }) => ({
  book: one(glBooks, { fields: [glFiscalYears.bookId], references: [glBooks.id] }),
  periods: many(glPeriods),
}));

/* ----------------------------------------------------------------- types */

export type GlAccount = typeof glAccounts.$inferSelect;
export type GlFiscalYear = typeof glFiscalYears.$inferSelect;
export type GlPeriod = typeof glPeriods.$inferSelect;
