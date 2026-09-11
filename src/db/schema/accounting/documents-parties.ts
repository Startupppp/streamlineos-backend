/**
 * The document vocabulary — party roles, AR and AP document types, document and
 * settlement states — and the parties every document is raised against.
 *
 * Split out of `documents.ts`, which re-exports every name here, so importing
 * from either file reaches the same tables and enums.
 */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { glAccounts, glBooks } from "./gl-kernel";

/* ------------------------------------------------------------------ enums */

export const partyRoleEnum = pgEnum("party_role", ["customer", "vendor", "both"]);

export const arDocumentTypeEnum = pgEnum("ar_document_type", ["INVOICE", "CREDIT_NOTE"]);
export const apDocumentTypeEnum = pgEnum("ap_document_type", ["BILL", "DEBIT_NOTE"]);

/**
 * `draft` is mutable and has no journal. `posted` is immutable — a correction is
 * a credit note, never an edit. There is no `cancelled` for a posted tax
 * document; that is an e-invoice concern (PRD 13).
 */
export const documentStatusEnum = pgEnum("acct_document_status", [
  "DRAFT",
  "POSTED",
  "PARTIALLY_PAID",
  "PAID",
  "VOID",
]);

export const settlementStatusEnum = pgEnum("acct_settlement_status", ["POSTED", "REVERSED"]);

/* ---------------------------------------------------------------- parties */

/**
 * A customer or vendor as accounting sees them.
 *
 * `external_refs` points back at the CRM company or contact rather than copying
 * it, so StreamlineOS's "one identity" thesis holds for people and companies
 * (A2). If CRM is empty, accounting owns the party outright — the module must
 * work standalone (A12).
 */
export const glParties = pgTable(
  "gl_parties",
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

    role: partyRoleEnum("role").notNull().default("customer"),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    email: text("email"),
    phone: text("phone"),

    countryCode: text("country_code").notNull(),
    defaultCurrency: text("default_currency").notNull(),

    /** Structured, because tax determination needs `region`, not a blob of text. */
    billingLine1: text("billing_line1"),
    billingLine2: text("billing_line2"),
    billingCity: text("billing_city"),
    billingRegion: text("billing_region"),
    billingPostalCode: text("billing_postal_code"),
    billingCountryCode: text("billing_country_code"),

    shippingLine1: text("shipping_line1"),
    shippingCity: text("shipping_city"),
    shippingRegion: text("shipping_region"),
    shippingPostalCode: text("shipping_postal_code"),
    shippingCountryCode: text("shipping_country_code"),

    /** `[{ system: 'crm', id: '...' }]` — a pointer, never a copy. */
    externalRefs: jsonb("external_refs")
      .$type<Array<{ system: string; id: string }>>()
      .notNull()
      .default([]),

    defaultIncomeAccountId: text("default_income_account_id").references(() => glAccounts.id, {
      onDelete: "set null",
    }),
    defaultExpenseAccountId: text("default_expense_account_id").references(() => glAccounts.id, {
      onDelete: "set null",
    }),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),

    /** India TDS section / generic WHT code. Rates live in dated config. */
    withholdingCode: text("withholding_code"),

    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    unique("uniq_gl_parties_org_id").on(t.orgId, t.id),
    unique("uniq_gl_parties_book_id").on(t.bookId, t.id),
    index("idx_gl_parties_book_role")
      .on(t.bookId, t.role)
      .where(sql`deleted_at IS NULL`),
    index("idx_gl_parties_org_book").on(t.orgId, t.bookId),
    check("ck_gl_parties_currency", sql`default_currency ~ '^[A-Z]{3}$'`),
    check("ck_gl_parties_terms", sql`payment_terms_days >= 0`),
  ],
);

/*
  `glPartiesRelations` stays in `documents.ts`: it names the AR and AP document
  tables, which import this file, so declaring it here would be a cycle.
*/

/* ------------------------------------------------------------------ types */

export type GlParty = typeof glParties.$inferSelect;
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];
export type ArDocumentType = (typeof arDocumentTypeEnum.enumValues)[number];
export type ApDocumentType = (typeof apDocumentTypeEnum.enumValues)[number];
export type PartyRole = (typeof partyRoleEnum.enumValues)[number];
