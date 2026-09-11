/**
 * Pluggable tax determination (PRD 10) plus the frozen result on posted
 * documents.
 *
 * The engine is a **plugin**: India GST is pack `IN`, and AR/AP never branch on
 * a country code. Rates are dated rows, not application constants — a rate
 * change must never rewrite a document that was already posted.
 */
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../common/auth";
import { glAccounts, glBooks } from "./gl-kernel";

/* ------------------------------------------------------------------ enums */

/**
 * What a line is, tax-wise, independent of jurisdiction. A pack maps these onto
 * its own rates; `reverse_charge` is a category because the buyer accounts for
 * the tax in India RCM and EU intra-community alike.
 */
export const taxCategoryEnum = pgEnum("tax_category", [
  "standard",
  "reduced",
  "super_reduced",
  "zero",
  "exempt",
  "out_of_scope",
  "reverse_charge",
]);

/** Where a component lands in the ledger. The engine says; AP/AR obey. */
export const taxGlRoleEnum = pgEnum("tax_gl_role", [
  "output_payable",
  "input_recoverable",
  "reverse_charge_output",
  "reverse_charge_input",
  /** Blocked input tax (India s17(5), entertainment elsewhere) — costed, not recovered. */
  "blocked_input",
  "withheld",
]);

/**
 * Generic shape of a supply. India's B2B/B2C/export/SEZ and the EU's
 * intra-community/OSS both project onto this, so documents carry one field.
 */
export const taxSupplyNatureEnum = pgEnum("tax_supply_nature", [
  "domestic_b2b",
  "domestic_b2c",
  "export",
  "import",
  "intra_community",
  "oss_b2c",
  "reverse_charge",
  "outside_scope",
]);

/** Identifier schemes a registration can carry. */
export const taxRegimeEnum = pgEnum("tax_regime", [
  "GST_IN",
  "VAT_EU",
  "VAT_GB",
  "VAT_GCC",
  "GST_SG",
  "GST_AU",
  "GST_HST_CA",
  "SALES_TAX_US",
  "PAN_IN",
  "TAN_IN",
  "EIN_US",
  "GENERIC",
]);

export const taxRegistrationOwnerEnum = pgEnum("tax_registration_owner", ["book", "party"]);

/* ------------------------------------------------------------- tax codes */

export const taxCodes = pgTable(
  "tax_codes",
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

    /** Which engine owns this code — `IN`, `GENERIC_VAT`, … */
    pack: text("pack").notNull(),
    /** User-facing handle: `IN_GST_18`, `EU_VAT_STD`. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: taxCategoryEnum("category").notNull().default("standard"),

    /** Seeded by the pack; a tenant may add its own but not delete these. */
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    description: text("description"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_tax_codes_org_id").on(t.orgId, t.id),
    unique("uniq_tax_codes_book_id").on(t.bookId, t.id),
    uniqueIndex("uniq_tax_codes_book_code").on(t.bookId, t.code),
    index("idx_tax_codes_book_active").on(t.bookId, t.isActive),
  ],
);

/**
 * A dated rate for one component of a code. `effective_to` null means "still
 * current". Determination picks the row whose window contains the *document
 * date*, which is why changing a rate tomorrow cannot alter yesterday's invoice.
 */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taxCodeId: text("tax_code_id")
      .notNull()
      .references(() => taxCodes.id, { onDelete: "cascade" }),

    /** `CGST`, `SGST`, `IGST`, `UTGST`, `CESS`, `VAT`, `STATE`, `COUNTY`… */
    component: text("component").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    /** Basis points: 1800 = 18.00%. Integer, so no float ever touches a rate. */
    rateBp: integer("rate_bp").notNull(),

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_tax_rates_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_tax_rates_code_component_from").on(t.taxCodeId, t.component, t.effectiveFrom),
    index("idx_tax_rates_code_window").on(t.taxCodeId, t.effectiveFrom, t.effectiveTo),
    check("ck_tax_rates_bp", sql`rate_bp >= 0 AND rate_bp <= 100000`),
    check("ck_tax_rates_window", sql`effective_to IS NULL OR effective_to >= effective_from`),
  ],
);

/**
 * A tax identity — the seller's GSTIN, the buyer's VAT number.
 *
 * Owner is an **exclusive arc** rather than a polymorphic `owner_type/owner_id`
 * pair: one nullable FK per kind plus a CHECK that exactly one is set, so
 * referential integrity survives (backend CLAUDE.md §3).
 */
export const taxRegistrations = pgTable(
  "tax_registrations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerType: taxRegistrationOwnerEnum("owner_type").notNull(),

    bookId: text("book_id").references(() => glBooks.id, { onDelete: "cascade" }),
    /** FK added with the party master in the AR/AP migration. */
    partyId: text("party_id"),

    regime: taxRegimeEnum("regime").notNull(),
    /** GSTIN, VAT id, EIN. Stored as given, uppercased by the service. */
    number: text("number").notNull(),
    /** State/province — first two digits of a GSTIN, a US state code. */
    region: text("region"),
    countryCode: text("country_code").notNull(),

    isPrimary: boolean("is_primary").notNull().default(false),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_tax_registrations_org_id").on(t.orgId, t.id),
    index("idx_tax_registrations_book").on(t.bookId, t.regime),
    index("idx_tax_registrations_party").on(t.partyId, t.regime),
    uniqueIndex("uniq_tax_registrations_book_primary")
      .on(t.bookId, t.regime)
      .where(sql`is_primary = true AND book_id IS NOT NULL`),
    check(
      "ck_tax_registrations_owner_arc",
      sql`(owner_type = 'book' AND book_id IS NOT NULL AND party_id IS NULL)
       OR (owner_type = 'party' AND party_id IS NOT NULL AND book_id IS NULL)`,
    ),
  ],
);

/**
 * Which GL account a component posts to, for a given role. This is what keeps
 * "CGST input" out of the AP service — AP asks for the account behind
 * (`input_recoverable`, `CGST`) and gets one.
 */
export const taxGlMap = pgTable(
  "tax_gl_map",
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

    glRole: taxGlRoleEnum("gl_role").notNull(),
    component: text("component").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_tax_gl_map_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_tax_gl_map_book_role_component").on(t.bookId, t.glRole, t.component),
    index("idx_tax_gl_map_book").on(t.bookId),
  ],
);

/**
 * The engine's output, **frozen** on the document at post time.
 *
 * Reports read these rows rather than re-running determination, so a GSTR
 * summary for a closed month cannot shift because someone edited a rate.
 */
export const taxDocumentLines = pgTable(
  "tax_document_lines",
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

    /** `sales_invoice`, `credit_note`, `purchase_bill`, `debit_note`. */
    documentType: text("document_type").notNull(),
    documentId: text("document_id").notNull(),
    documentLineId: text("document_line_id"),

    taxCodeId: text("tax_code_id").references(() => taxCodes.id, { onDelete: "restrict" }),
    component: text("component").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    rateBp: integer("rate_bp").notNull(),

    taxableMinor: bigint("taxable_minor", { mode: "number" }).notNull(),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull(),
    /** Transaction currency; the functional conversion lives on the journal. */
    currency: text("currency").notNull(),

    glRole: taxGlRoleEnum("gl_role").notNull(),
    recoverable: boolean("recoverable").notNull().default(false),
    glAccountId: text("gl_account_id").references(() => glAccounts.id, { onDelete: "restrict" }),

    /** The engine's raw verdict, for audit and for explaining a number later. */
    rawResult: jsonb("raw_result").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_tax_document_lines_org_id").on(t.orgId, t.id),
    index("idx_tax_document_lines_document").on(t.bookId, t.documentType, t.documentId),
    /** The tax-summary access path: everything in a period by role and component. */
    index("idx_tax_document_lines_book_role").on(t.bookId, t.glRole, t.component),
    index("idx_tax_document_lines_code").on(t.bookId, t.taxCodeId),
    check("ck_tax_document_lines_taxable", sql`taxable_minor >= 0`),
  ],
);

/* --------------------------------------------------------------- relations */

export const taxCodesRelations = relations(taxCodes, ({ one, many }) => ({
  organization: one(organizations, { fields: [taxCodes.orgId], references: [organizations.id] }),
  book: one(glBooks, { fields: [taxCodes.bookId], references: [glBooks.id] }),
  rates: many(taxRates),
}));

export const taxRatesRelations = relations(taxRates, ({ one }) => ({
  taxCode: one(taxCodes, { fields: [taxRates.taxCodeId], references: [taxCodes.id] }),
}));

export const taxRegistrationsRelations = relations(taxRegistrations, ({ one }) => ({
  book: one(glBooks, { fields: [taxRegistrations.bookId], references: [glBooks.id] }),
}));

export const taxGlMapRelations = relations(taxGlMap, ({ one }) => ({
  book: one(glBooks, { fields: [taxGlMap.bookId], references: [glBooks.id] }),
  account: one(glAccounts, { fields: [taxGlMap.accountId], references: [glAccounts.id] }),
}));

export const taxDocumentLinesRelations = relations(taxDocumentLines, ({ one }) => ({
  book: one(glBooks, { fields: [taxDocumentLines.bookId], references: [glBooks.id] }),
  taxCode: one(taxCodes, { fields: [taxDocumentLines.taxCodeId], references: [taxCodes.id] }),
  glAccount: one(glAccounts, {
    fields: [taxDocumentLines.glAccountId],
    references: [glAccounts.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type TaxCode = typeof taxCodes.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxRegistration = typeof taxRegistrations.$inferSelect;
export type TaxDocumentLine = typeof taxDocumentLines.$inferSelect;
export type TaxCategory = (typeof taxCategoryEnum.enumValues)[number];
export type TaxGlRole = (typeof taxGlRoleEnum.enumValues)[number];
export type TaxSupplyNature = (typeof taxSupplyNatureEnum.enumValues)[number];
export type TaxRegime = (typeof taxRegimeEnum.enumValues)[number];
