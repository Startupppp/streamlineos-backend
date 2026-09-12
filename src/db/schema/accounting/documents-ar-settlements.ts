/**
 * AR settlements — receipts, and the allocations that apply a receipt or a
 * credit note to an invoice.
 *
 * Split out of `documents.ts`, which re-exports every name here, so importing
 * from either file reaches the same tables.
 */
import {
  bigint,
  check,
  date,
  index,
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
import { arDocuments } from "./documents-ar";

/* ------------------------------------------------------------- AR receipts */

export const arReceipts = pgTable(
  "ar_receipts",
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

    receiptNumber: text("receipt_number"),
    receiptDate: date("receipt_date").notNull(),
    /** The cash or bank GL account the money landed in. */
    depositAccountId: text("deposit_account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),

    currency: text("currency").notNull(),
    fxRate: numeric("fx_rate", { precision: 18, scale: 10 }).notNull().default("1"),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    /** Received but not yet applied to an invoice — a customer advance. */
    unappliedMinor: bigint("unapplied_minor", { mode: "number" }).notNull().default(0),

    status: settlementStatusEnum("status").notNull().default("POSTED"),
    paymentMethod: text("payment_method"),
    reference: text("reference"),
    memo: text("memo"),

    /** `psp:{provider}:{id}` reserved for PRD 14 webhook idempotency. */
    providerPaymentId: text("provider_payment_id"),

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
    unique("uniq_ar_receipts_org_id").on(t.orgId, t.id),
    unique("uniq_ar_receipts_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_ar_receipts_book_number")
      .on(t.bookId, t.receiptNumber)
      .where(sql`receipt_number IS NOT NULL`),
    /** One receipt per PSP capture (PRD 14 invariant). */
    uniqueIndex("uniq_ar_receipts_provider_payment")
      .on(t.bookId, t.providerPaymentId)
      .where(sql`provider_payment_id IS NOT NULL`),
    index("idx_ar_receipts_book_party").on(t.bookId, t.partyId, t.receiptDate),
    index("idx_ar_receipts_book_date").on(t.bookId, t.receiptDate),
    check("ck_ar_receipts_amount", sql`amount_minor > 0`),
    check("ck_ar_receipts_unapplied", sql`unapplied_minor >= 0 AND unapplied_minor <= amount_minor`),
  ],
);

/**
 * Which receipt paid which document. The sum of allocations is what moves an
 * invoice from posted to partially-paid to paid, so aging is derived from these
 * rows rather than from a status somebody remembered to update.
 */
export const arAllocations = pgTable(
  "ar_allocations",
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

    /** Exactly one source: a receipt, or a credit note being applied. */
    receiptId: text("receipt_id").references(() => arReceipts.id, { onDelete: "cascade" }),
    creditNoteId: text("credit_note_id").references(() => arDocuments.id, { onDelete: "cascade" }),

    documentId: text("document_id")
      .notNull()
      .references(() => arDocuments.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_ar_allocations_org_id").on(t.orgId, t.id),
    index("idx_ar_allocations_document").on(t.documentId),
    index("idx_ar_allocations_receipt").on(t.receiptId),
    index("idx_ar_allocations_credit_note").on(t.creditNoteId),
    /** A receipt cannot be applied to the same invoice twice. */
    uniqueIndex("uniq_ar_allocations_receipt_document")
      .on(t.receiptId, t.documentId)
      .where(sql`receipt_id IS NOT NULL`),
    uniqueIndex("uniq_ar_allocations_credit_document")
      .on(t.creditNoteId, t.documentId)
      .where(sql`credit_note_id IS NOT NULL`),
    check("ck_ar_allocations_amount", sql`amount_minor > 0`),
    check(
      "ck_ar_allocations_source_arc",
      sql`(receipt_id IS NOT NULL AND credit_note_id IS NULL)
       OR (receipt_id IS NULL AND credit_note_id IS NOT NULL)`,
    ),
  ],
);

/* --------------------------------------------------------------- relations */

export const arReceiptsRelations = relations(arReceipts, ({ one, many }) => ({
  book: one(glBooks, { fields: [arReceipts.bookId], references: [glBooks.id] }),
  party: one(glParties, { fields: [arReceipts.partyId], references: [glParties.id] }),
  depositAccount: one(glAccounts, {
    fields: [arReceipts.depositAccountId],
    references: [glAccounts.id],
  }),
  allocations: many(arAllocations),
}));

export const arAllocationsRelations = relations(arAllocations, ({ one }) => ({
  receipt: one(arReceipts, { fields: [arAllocations.receiptId], references: [arReceipts.id] }),
  document: one(arDocuments, { fields: [arAllocations.documentId], references: [arDocuments.id] }),
}));

/* ------------------------------------------------------------------ types */

export type ArReceipt = typeof arReceipts.$inferSelect;
