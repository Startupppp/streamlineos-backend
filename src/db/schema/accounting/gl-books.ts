/**
 * Books, the currency catalog, the currencies a book trades in, and FX rates —
 * the configuration every journal posts against.
 *
 * Split out of `gl-kernel.ts`, which re-exports every name here. `glBooksRelations`
 * lives in `gl-chart-and-calendar.ts`, because it names the accounts and fiscal
 * years declared there and this file sits upstream of both.
 */
import {
  boolean,
  check,
  date,
  index,
  integer,
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
import { legalEntities } from "../common/legal-entities";
import { glBookStatusEnum } from "./gl-enums";

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

/* ------------------------------------------------------------- relations */

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

/* ----------------------------------------------------------------- types */

export type GlBook = typeof glBooks.$inferSelect;
