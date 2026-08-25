/**
 * Source documents — parties, AR (invoices, credit notes, receipts) and AP
 * (bills, debit notes, payments, withholding).
 *
 * Documents are **sources**: they compute, they freeze tax, and they emit a
 * `PostJournal`. They never write a journal line themselves.
 *
 * Invoices and credit notes share one table discriminated by `document_type`,
 * as do bills and debit notes. Their columns are identical and a credit note is
 * a signed invoice; two tables would mean two open-item calculations that could
 * disagree. This is a discriminated table with real foreign keys, not the
 * `entity_type`/`entity_id` polymorphism backend/CLAUDE.md §3 bans.
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
import { glAccounts, glBooks, glJournals } from "./gl-kernel";
import { taxCategoryEnum, taxSupplyNatureEnum } from "./tax";

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

export const glPartiesRelations = relations(glParties, ({ one, many }) => ({
  book: one(glBooks, { fields: [glParties.bookId], references: [glBooks.id] }),
  arDocuments: many(arDocuments),
  apDocuments: many(apDocuments),
}));

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

export type GlParty = typeof glParties.$inferSelect;
export type ArDocument = typeof arDocuments.$inferSelect;
export type ArDocumentLine = typeof arDocumentLines.$inferSelect;
export type ArReceipt = typeof arReceipts.$inferSelect;
export type ApDocument = typeof apDocuments.$inferSelect;
export type ApDocumentLine = typeof apDocumentLines.$inferSelect;
export type ApPayment = typeof apPayments.$inferSelect;
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];
export type ArDocumentType = (typeof arDocumentTypeEnum.enumValues)[number];
export type ApDocumentType = (typeof apDocumentTypeEnum.enumValues)[number];
export type PartyRole = (typeof partyRoleEnum.enumValues)[number];
