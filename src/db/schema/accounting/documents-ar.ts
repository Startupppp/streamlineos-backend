/**
 * AR documents — invoices and credit notes in one table discriminated by
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
import { arDocumentTypeEnum, documentStatusEnum, glParties } from "./documents-parties";

/* ------------------------------------------------------------ AR documents */

export const arDocuments = pgTable(
  "ar_documents",
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

    documentType: arDocumentTypeEnum("document_type").notNull(),
    status: documentStatusEnum("status").notNull().default("DRAFT"),

    /** Null while draft; assigned at post, unique per book once set. */
    documentNumber: text("document_number"),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date"),

    currency: text("currency").notNull(),
    fxRate: numeric("fx_rate", { precision: 18, scale: 10 }).notNull().default("1"),

    /** Tax-engine inputs, named generically so no column says "GST". */
    supplyNature: taxSupplyNatureEnum("supply_nature").notNull().default("domestic_b2b"),
    taxLocationFromCountry: text("tax_location_from_country"),
    taxLocationFromRegion: text("tax_location_from_region"),
    taxLocationToCountry: text("tax_location_to_country"),
    taxLocationToRegion: text("tax_location_to_region"),
    /** India: place-of-supply state code. Generic elsewhere. */
    placeOfSupplyCode: text("place_of_supply_code"),
    taxInclusive: boolean("tax_inclusive").notNull().default(false),

    /** Totals in transaction currency; functional equivalents alongside. */
    netMinor: bigint("net_minor", { mode: "number" }).notNull().default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull().default(0),
    roundingMinor: bigint("rounding_minor", { mode: "number" }).notNull().default(0),
    functionalGrossMinor: bigint("functional_gross_minor", { mode: "number" }).notNull().default(0),

    /** Settled so far, transaction currency. Open item = gross - settled. */
    settledMinor: bigint("settled_minor", { mode: "number" }).notNull().default(0),

    /** A credit note may reference the invoice it reverses. */
    originalDocumentId: text("original_document_id").references(
      (): AnyPgColumn => arDocuments.id,
      { onDelete: "restrict" },
    ),

    postedJournalId: text("posted_journal_id").references(() => glJournals.id, {
      onDelete: "restrict",
    }),

    memo: text("memo"),
    reference: text("reference"),
    /** Nullable e-invoice hooks — present day one so PRD 13 needs no migration. */
    irn: text("irn"),
    irnAckNo: text("irn_ack_no"),
    irnAckAt: timestamp("irn_ack_at"),
    signedQr: text("signed_qr"),
    irpStatus: text("irp_status"),
    /** `YYYY-MM`, derived at post from the document date. */
    gstrPeriod: text("gstr_period"),
    ecommerceGstin: text("ecommerce_gstin"),
    exportWithIgst: boolean("export_with_igst").notNull().default(false),

    /**
     * The rendered tax-invoice PDF in object storage.
     *
     * A posted document is immutable, so its PDF is too — render once, keep the
     * key, and every later download serves the same bytes the customer already
     * has. Null until first requested, and null forever if R2 is not
     * configured, which is why the endpoint still returns the bytes it just
     * generated rather than failing.
     *
     * `accounting` is a private folder root, so the URL is the key rather than
     * anything publicly fetchable — an invoice carries the customer's GSTIN and
     * address and is served only through the permission-gated route.
     */
    pdfStorageKey: text("pdf_storage_key"),
    pdfStorageUrl: text("pdf_storage_url"),

    /** CRM/project pointers, nullable — never a posting input. */
    crmDealId: text("crm_deal_id"),
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
    unique("uniq_ar_documents_org_id").on(t.orgId, t.id),
    unique("uniq_ar_documents_book_id").on(t.bookId, t.id),
    /** A tax document number is never reused, even after a soft delete. */
    uniqueIndex("uniq_ar_documents_book_number")
      .on(t.bookId, t.documentNumber)
      .where(sql`document_number IS NOT NULL`),
    /** One journal per document. */
    uniqueIndex("uniq_ar_documents_journal")
      .on(t.postedJournalId)
      .where(sql`posted_journal_id IS NOT NULL`),
    index("idx_ar_documents_book_status")
      .on(t.bookId, t.status, t.issueDate)
      .where(sql`deleted_at IS NULL`),
    /** The aging query: open items per party by date. */
    index("idx_ar_documents_book_party_open")
      .on(t.bookId, t.partyId, t.dueDate)
      .where(sql`status IN ('POSTED','PARTIALLY_PAID') AND deleted_at IS NULL`),
    index("idx_ar_documents_org_book").on(t.orgId, t.bookId),
    index("idx_ar_documents_gstr").on(t.bookId, t.gstrPeriod),
    check("ck_ar_documents_amounts", sql`net_minor >= 0 AND tax_minor >= 0 AND gross_minor >= 0`),
    check("ck_ar_documents_settled", sql`settled_minor >= 0 AND settled_minor <= gross_minor`),
    check("ck_ar_documents_currency", sql`currency ~ '^[A-Z]{3}$'`),
    check("ck_ar_documents_fx", sql`fx_rate > 0`),
    /** A posted document always has a number and a journal. */
    check(
      "ck_ar_documents_posted_complete",
      sql`status = 'DRAFT' OR (document_number IS NOT NULL AND posted_journal_id IS NOT NULL)`,
    ),
  ],
);

export const arDocumentLines = pgTable(
  "ar_document_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => arDocuments.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    description: text("description").notNull(),
    /** Thousandths, so 2.5 hours is exact. */
    quantityMilli: bigint("quantity_milli", { mode: "number" }).notNull().default(1000),
    unit: text("unit"),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }).notNull().default(0),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),

    taxCategory: taxCategoryEnum("tax_category").notNull().default("standard"),
    /** HSN/SAC in India, generic commodity code elsewhere. */
    commodityCode: text("commodity_code"),
    /** Overrides pack resolution, with a reason for the audit trail (PRD 10 S1). */
    forcedTaxCodeId: text("forced_tax_code_id"),
    forcedTaxReason: text("forced_tax_reason"),

    incomeAccountId: text("income_account_id").references(() => glAccounts.id, {
      onDelete: "restrict",
    }),

    lineNetMinor: bigint("line_net_minor", { mode: "number" }).notNull().default(0),
    lineTaxMinor: bigint("line_tax_minor", { mode: "number" }).notNull().default(0),
    lineGrossMinor: bigint("line_gross_minor", { mode: "number" }).notNull().default(0),

    dimensionProjectId: integer("dimension_project_id"),
    dimensionCostCenterId: text("dimension_cost_center_id"),
  },
  (t) => [
    unique("uniq_ar_document_lines_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_ar_document_lines_no").on(t.documentId, t.lineNo),
    index("idx_ar_document_lines_document").on(t.documentId),
    check("ck_ar_document_lines_quantity", sql`quantity_milli <> 0`),
    check("ck_ar_document_lines_discount", sql`discount_minor >= 0`),
  ],
);

/* --------------------------------------------------------------- relations */

export const arDocumentsRelations = relations(arDocuments, ({ one, many }) => ({
  book: one(glBooks, { fields: [arDocuments.bookId], references: [glBooks.id] }),
  party: one(glParties, { fields: [arDocuments.partyId], references: [glParties.id] }),
  journal: one(glJournals, { fields: [arDocuments.postedJournalId], references: [glJournals.id] }),
  original: one(arDocuments, {
    fields: [arDocuments.originalDocumentId],
    references: [arDocuments.id],
    relationName: "ar_document_original",
  }),
  lines: many(arDocumentLines),
}));

export const arDocumentLinesRelations = relations(arDocumentLines, ({ one }) => ({
  document: one(arDocuments, { fields: [arDocumentLines.documentId], references: [arDocuments.id] }),
  incomeAccount: one(glAccounts, {
    fields: [arDocumentLines.incomeAccountId],
    references: [glAccounts.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type ArDocument = typeof arDocuments.$inferSelect;
export type ArDocumentLine = typeof arDocumentLines.$inferSelect;
