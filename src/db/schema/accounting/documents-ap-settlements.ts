/**
 * AP settlements — payments, the allocations that apply a payment or a debit
 * note to a bill, and the tax withheld on a payment.
 *
 * Split out of `documents.ts`, which re-exports every name here, so importing
 * from either file reaches the same tables.
 */
import {
  bigint,
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
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { glAccounts, glBooks, glJournals } from "./gl-kernel";
import { glParties, settlementStatusEnum } from "./documents-parties";
import { apDocuments } from "./documents-ap";

/* ------------------------------------------------------------- AP payments */

export const apPayments = pgTable(
  "ap_payments",
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
    partyId: text("party_id")
      .notNull()
      .references(() => glParties.id, { onDelete: "restrict" }),

    paymentNumber: text("payment_number"),
    paymentDate: date("payment_date").notNull(),
    /** The cash or bank GL account the money left. */
    paymentAccountId: text("payment_account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),

    currency: text("currency").notNull(),
    fxRate: numeric("fx_rate", { precision: 18, scale: 10 }).notNull().default("1"),
    /**
     * `gross` is what the vendor was owed, `withheld` is tax retained, and the
     * bank movement is the difference. Keeping all three means a TDS challan
     * can be reconciled without recomputing anything.
     */
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull(),
    withheldMinor: bigint("withheld_minor", { mode: "number" }).notNull().default(0),
    netPaidMinor: bigint("net_paid_minor", { mode: "number" }).notNull(),
    unappliedMinor: bigint("unapplied_minor", { mode: "number" }).notNull().default(0),

    status: settlementStatusEnum("status").notNull().default("POSTED"),
    paymentMethod: text("payment_method"),
    reference: text("reference"),
    memo: text("memo"),

    postedJournalId: text("posted_journal_id").references(() => glJournals.id, {
      onDelete: "restrict",
    }),
    reversalJournalId: text("reversal_journal_id").references(() => glJournals.id, {
      onDelete: "restrict",
    }),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_ap_payments_org_id").on(t.orgId, t.id),
    unique("uniq_ap_payments_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_ap_payments_book_number")
      .on(t.bookId, t.paymentNumber)
      .where(sql`payment_number IS NOT NULL`),
    index("idx_ap_payments_book_party").on(t.bookId, t.partyId, t.paymentDate),
    index("idx_ap_payments_book_date").on(t.bookId, t.paymentDate),
    check("ck_ap_payments_gross", sql`gross_minor > 0`),
    check("ck_ap_payments_withheld", sql`withheld_minor >= 0 AND withheld_minor <= gross_minor`),
    check("ck_ap_payments_net", sql`net_paid_minor = gross_minor - withheld_minor`),
  ],
);

export const apAllocations = pgTable(
  "ap_allocations",
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

    paymentId: text("payment_id").references(() => apPayments.id, { onDelete: "cascade" }),
    debitNoteId: text("debit_note_id").references(() => apDocuments.id, { onDelete: "cascade" }),

    documentId: text("document_id")
      .notNull()
      .references(() => apDocuments.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_ap_allocations_org_id").on(t.orgId, t.id),
    index("idx_ap_allocations_document").on(t.documentId),
    index("idx_ap_allocations_payment").on(t.paymentId),
    index("idx_ap_allocations_debit_note").on(t.debitNoteId),
    uniqueIndex("uniq_ap_allocations_payment_document")
      .on(t.paymentId, t.documentId)
      .where(sql`payment_id IS NOT NULL`),
    uniqueIndex("uniq_ap_allocations_debit_document")
      .on(t.debitNoteId, t.documentId)
      .where(sql`debit_note_id IS NOT NULL`),
    check("ck_ap_allocations_amount", sql`amount_minor > 0`),
    check(
      "ck_ap_allocations_source_arc",
      sql`(payment_id IS NOT NULL AND debit_note_id IS NULL)
       OR (payment_id IS NULL AND debit_note_id IS NOT NULL)`,
    ),
  ],
);

/**
 * Tax withheld on a payment — India TDS, generic WHT elsewhere.
 *
 * `legacy_section` and `payment_code` both exist because Indian practice still
 * speaks in 194J while the Income Tax Act 2025 files it under §393. Rates are
 * dated config, never constants (PRD 03 S3).
 */
export const apWithholding = pgTable(
  "ap_withholding",
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
    paymentId: text("payment_id")
      .notNull()
      .references(() => apPayments.id, { onDelete: "cascade" }),
    documentId: text("document_id").references(() => apDocuments.id, { onDelete: "set null" }),

    regime: text("regime").notNull().default("GENERIC_WHT"),
    legacySection: text("legacy_section"),
    paymentCode: text("payment_code"),
    rateBp: integer("rate_bp").notNull(),

    baseMinor: bigint("base_minor", { mode: "number" }).notNull(),
    withheldMinor: bigint("withheld_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),

    glAccountId: text("gl_account_id").references(() => glAccounts.id, { onDelete: "restrict" }),
    /** Challan / remittance reference once the tax is paid over. */
    remittanceReference: text("remittance_reference"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_ap_withholding_org_id").on(t.orgId, t.id),
    index("idx_ap_withholding_payment").on(t.paymentId),
    index("idx_ap_withholding_book_date").on(t.bookId, t.createdAt),
    check("ck_ap_withholding_base", sql`base_minor > 0`),
    check("ck_ap_withholding_amount", sql`withheld_minor >= 0 AND withheld_minor <= base_minor`),
    check("ck_ap_withholding_rate", sql`rate_bp >= 0 AND rate_bp <= 10000`),
  ],
);

/* --------------------------------------------------------------- relations */

export const apPaymentsRelations = relations(apPayments, ({ one, many }) => ({
  book: one(glBooks, { fields: [apPayments.bookId], references: [glBooks.id] }),
  party: one(glParties, { fields: [apPayments.partyId], references: [glParties.id] }),
  paymentAccount: one(glAccounts, {
    fields: [apPayments.paymentAccountId],
    references: [glAccounts.id],
  }),
  allocations: many(apAllocations),
  withholding: many(apWithholding),
}));

export const apAllocationsRelations = relations(apAllocations, ({ one }) => ({
  payment: one(apPayments, { fields: [apAllocations.paymentId], references: [apPayments.id] }),
  document: one(apDocuments, { fields: [apAllocations.documentId], references: [apDocuments.id] }),
}));

export const apWithholdingRelations = relations(apWithholding, ({ one }) => ({
  payment: one(apPayments, { fields: [apWithholding.paymentId], references: [apPayments.id] }),
  document: one(apDocuments, { fields: [apWithholding.documentId], references: [apDocuments.id] }),
}));

/* ------------------------------------------------------------------ types */

export type ApPayment = typeof apPayments.$inferSelect;
