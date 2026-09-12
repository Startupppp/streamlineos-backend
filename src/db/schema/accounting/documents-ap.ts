/**
 * AP documents — bills and debit notes in one table discriminated by
 * `document_type` — and their lines.
 *
 * Split out of `documents.ts`, which re-exports every name here, so importing
 * from either file reaches the same tables.
 */
import {
  bigint,
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
import { glAccounts, glBooks, glJournals } from "./gl-kernel";
import { taxCategoryEnum, taxSupplyNatureEnum } from "./tax";
import { apDocumentTypeEnum, documentStatusEnum, glParties } from "./documents-parties";

/* ------------------------------------------------------------ AP documents */

export const apDocuments = pgTable(
  "ap_documents",
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

    documentType: apDocumentTypeEnum("document_type").notNull(),
    status: documentStatusEnum("status").notNull().default("DRAFT"),

    /** Our internal number. */
    documentNumber: text("document_number"),
    /** The vendor's own number, which is what a tax authority matches on. */
    vendorDocumentNumber: text("vendor_document_number"),
    vendorDocumentDate: date("vendor_document_date"),

    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date"),

    currency: text("currency").notNull(),
    fxRate: numeric("fx_rate", { precision: 18, scale: 10 }).notNull().default("1"),

    supplyNature: taxSupplyNatureEnum("supply_nature").notNull().default("domestic_b2b"),
    taxLocationFromCountry: text("tax_location_from_country"),
    taxLocationFromRegion: text("tax_location_from_region"),
    taxLocationToCountry: text("tax_location_to_country"),
    taxLocationToRegion: text("tax_location_to_region"),
    placeOfSupplyCode: text("place_of_supply_code"),
    taxInclusive: boolean("tax_inclusive").notNull().default(false),
    reverseCharge: boolean("reverse_charge").notNull().default(false),
    /** Input tax that cannot be recovered is costed, not capitalised (M8). */
    blockedInputTax: boolean("blocked_input_tax").notNull().default(false),

    netMinor: bigint("net_minor", { mode: "number" }).notNull().default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull().default(0),
    roundingMinor: bigint("rounding_minor", { mode: "number" }).notNull().default(0),
    functionalGrossMinor: bigint("functional_gross_minor", { mode: "number" }).notNull().default(0),
    settledMinor: bigint("settled_minor", { mode: "number" }).notNull().default(0),

    originalDocumentId: text("original_document_id").references(
      (): AnyPgColumn => apDocuments.id,
      { onDelete: "restrict" },
    ),
    postedJournalId: text("posted_journal_id").references(() => glJournals.id, {
      onDelete: "restrict",
    }),

    memo: text("memo"),
    reference: text("reference"),
    gstrPeriod: text("gstr_period"),
    /** IMS / GSTR-2B reconciliation status, for input-credit work later. */
    imsStatus: text("ims_status"),

    dimensionProjectId: integer("dimension_project_id"),

    postedBy: text("posted_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    unique("uniq_ap_documents_org_id").on(t.orgId, t.id),
    unique("uniq_ap_documents_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_ap_documents_book_number")
      .on(t.bookId, t.documentNumber)
      .where(sql`document_number IS NOT NULL`),
    /**
     * The same vendor cannot bill the same number twice — this is the duplicate
     * check PRD 03 M3 asks for, enforced rather than warned about.
     */
    uniqueIndex("uniq_ap_documents_vendor_number")
      .on(t.bookId, t.partyId, t.vendorDocumentNumber)
      .where(sql`vendor_document_number IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("uniq_ap_documents_journal")
      .on(t.postedJournalId)
      .where(sql`posted_journal_id IS NOT NULL`),
    index("idx_ap_documents_book_status")
      .on(t.bookId, t.status, t.issueDate)
      .where(sql`deleted_at IS NULL`),
    index("idx_ap_documents_book_party_open")
      .on(t.bookId, t.partyId, t.dueDate)
      .where(sql`status IN ('POSTED','PARTIALLY_PAID') AND deleted_at IS NULL`),
    index("idx_ap_documents_org_book").on(t.orgId, t.bookId),
    check("ck_ap_documents_amounts", sql`net_minor >= 0 AND tax_minor >= 0 AND gross_minor >= 0`),
    check("ck_ap_documents_settled", sql`settled_minor >= 0 AND settled_minor <= gross_minor`),
    check("ck_ap_documents_currency", sql`currency ~ '^[A-Z]{3}$'`),
    check("ck_ap_documents_fx", sql`fx_rate > 0`),
    check(
      "ck_ap_documents_posted_complete",
      sql`status = 'DRAFT' OR (document_number IS NOT NULL AND posted_journal_id IS NOT NULL)`,
    ),
  ],
);

export const apDocumentLines = pgTable(
  "ap_document_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => apDocuments.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull().default(1000),
    unit: text("unit"),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }).notNull().default(0),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),

    taxCategory: taxCategoryEnum("tax_category").notNull().default("standard"),
    commodityCode: text("commodity_code"),
    forcedTaxCodeId: text("forced_tax_code_id"),
    forcedTaxReason: text("forced_tax_reason"),

    /** Expense or asset — whichever the spend actually is. */
    expenseAccountId: text("expense_account_id").references(() => glAccounts.id, {
      onDelete: "restrict",
    }),
    /** Set when the line should become a fixed asset rather than an expense. */
    capitalize: boolean("capitalize").notNull().default(false),

    lineNetMinor: bigint("line_net_minor", { mode: "number" }).notNull().default(0),
    lineTaxMinor: bigint("line_tax_minor", { mode: "number" }).notNull().default(0),
    lineGrossMinor: bigint("line_gross_minor", { mode: "number" }).notNull().default(0),

    dimensionProjectId: integer("dimension_project_id"),
    dimensionCostCenterId: text("dimension_cost_center_id"),
  },
  (t) => [
    unique("uniq_ap_document_lines_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_ap_document_lines_no").on(t.documentId, t.lineNo),
    index("idx_ap_document_lines_document").on(t.documentId),
    check("ck_ap_document_lines_quantity", sql`quantity_milli <> 0`),
    check("ck_ap_document_lines_discount", sql`discount_minor >= 0`),
  ],
);

/* --------------------------------------------------------------- relations */

export const apDocumentsRelations = relations(apDocuments, ({ one, many }) => ({
  book: one(glBooks, { fields: [apDocuments.bookId], references: [glBooks.id] }),
  party: one(glParties, { fields: [apDocuments.partyId], references: [glParties.id] }),
  journal: one(glJournals, { fields: [apDocuments.postedJournalId], references: [glJournals.id] }),
  original: one(apDocuments, {
    fields: [apDocuments.originalDocumentId],
    references: [apDocuments.id],
    relationName: "ap_document_original",
  }),
  lines: many(apDocumentLines),
}));

export const apDocumentLinesRelations = relations(apDocumentLines, ({ one }) => ({
  document: one(apDocuments, { fields: [apDocumentLines.documentId], references: [apDocuments.id] }),
  expenseAccount: one(glAccounts, {
    fields: [apDocumentLines.expenseAccountId],
    references: [glAccounts.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type ApDocument = typeof apDocuments.$inferSelect;
export type ApDocumentLine = typeof apDocumentLines.$inferSelect;
