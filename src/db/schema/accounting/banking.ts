/**
 * Banking and reconciliation (PRD 04).
 *
 * A bank account **is** a GL account with `is_cash` set, plus the metadata a
 * bank needs. There is no parallel balance field — the cash balance is the sum
 * of journal lines, which is why GL and bank can be reconciled at all.
 *
 * The rails differ (HDFC, Mercury, Wise); reconciliation does not.
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
import { organizations, users } from "../common/auth";
import { glAccounts, glBooks, glJournals } from "./gl-kernel";
import { apPayments, arReceipts } from "./documents";

/** Generic identifier schemes, so no column is called `ifsc`. */
export const bankIdentifierSchemeEnum = pgEnum("bank_identifier_scheme", [
  "IFSC_ACCOUNT",
  "IBAN",
  "ROUTING_ACCOUNT",
  "SORT_ACCOUNT",
  "BSB_ACCOUNT",
  "UPI",
  "OTHER",
]);

export const bankStatementSourceEnum = pgEnum("bank_statement_source", ["csv", "manual", "feed"]);

export const bankMatchKindEnum = pgEnum("bank_match_kind", ["receipt", "payment", "journal"]);

/** Bank metadata hung off a cash GL account. */
export const bankProfiles = pgTable(
  "bank_profiles",
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
    accountId: text("account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),

    displayName: text("display_name").notNull(),
    bankName: text("bank_name"),
    /** Statements arrive in this currency; reconciliation compares in it (M7). */
    currency: text("currency").notNull(),
    countryCode: text("country_code").notNull(),

    identifierScheme: bankIdentifierSchemeEnum("identifier_scheme"),
    identifierValue: text("identifier_value"),
    /** Sort code / IFSC / routing number, kept apart from the account number. */
    branchIdentifier: text("branch_identifier"),

    /**
     * Saved column mapping for this account's CSV exports — every bank ships a
     * different layout, and `DD/MM` vs `MM/DD` must be explicit, never guessed.
     */
    csvMapping: jsonb("csv_mapping").$type<{
      dateColumn?: string;
      descriptionColumn?: string;
      referenceColumn?: string;
      amountColumn?: string;
      debitColumn?: string;
      creditColumn?: string;
      dateFormat?: string;
      skipRows?: number;
    }>(),

    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("uniq_bank_profiles_org_id").on(t.orgId, t.id),
    /** One profile per GL account — an account is one bank account or none. */
    uniqueIndex("uniq_bank_profiles_account").on(t.accountId),
    index("idx_bank_profiles_book").on(t.bookId, t.isActive),
    check("ck_bank_profiles_currency", sql`currency ~ '^[A-Z]{3}$'`),
  ],
);

export const bankStatements = pgTable(
  "bank_statements",
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
    bankProfileId: text("bank_profile_id")
      .notNull()
      .references(() => bankProfiles.id, { onDelete: "cascade" }),

    source: bankStatementSourceEnum("source").notNull().default("csv"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    openingMinor: bigint("opening_minor", { mode: "number" }).notNull(),
    closingMinor: bigint("closing_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),

    /** SHA-256 of the uploaded file, so the same export cannot import twice (S1). */
    fileHash: text("file_hash"),
    fileName: text("file_name"),
    /** Set once opening + movements = closing and everything is explained. */
    reconciledAt: timestamp("reconciled_at"),
    reconciledBy: text("reconciled_by").references(() => users.id, { onDelete: "set null" }),

    importedBy: text("imported_by").references(() => users.id, { onDelete: "set null" }),
    importedAt: timestamp("imported_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_bank_statements_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_bank_statements_profile_hash")
      .on(t.bankProfileId, t.fileHash)
      .where(sql`file_hash IS NOT NULL`),
    index("idx_bank_statements_profile_period").on(t.bankProfileId, t.periodEnd),
    index("idx_bank_statements_book").on(t.bookId, t.periodEnd),
    check("ck_bank_statements_period", sql`period_end >= period_start`),
  ],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    statementId: text("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    valueDate: date("value_date").notNull(),
    /** Signed: positive is money in, negative is money out. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    description: text("description"),
    bankReference: text("bank_reference"),
    /** The original row, so an import can be explained after the fact. */
    rawRow: jsonb("raw_row").$type<Record<string, string>>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_bank_statement_lines_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_bank_statement_lines_no").on(t.statementId, t.lineNo),
    index("idx_bank_statement_lines_statement").on(t.statementId),
    index("idx_bank_statement_lines_date").on(t.statementId, t.valueDate),
    check("ck_bank_statement_lines_amount", sql`amount_minor <> 0`),
  ],
);

/**
 * A statement line matched to something in the books.
 *
 * v1 is strictly 1:1 — the unique on `statement_line_id` and the partial
 * uniques on each counterpart together stop one receipt being used to explain
 * two different bank lines (M5).
 */
export const bankMatches = pgTable(
  "bank_matches",
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

    statementLineId: text("statement_line_id")
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: "cascade" }),

    kind: bankMatchKindEnum("kind").notNull(),
    /** Exclusive arc — exactly one counterpart, each a real foreign key. */
    receiptId: text("receipt_id").references(() => arReceipts.id, { onDelete: "cascade" }),
    paymentId: text("payment_id").references(() => apPayments.id, { onDelete: "cascade" }),
    journalId: text("journal_id").references(() => glJournals.id, { onDelete: "cascade" }),

    matchedBy: text("matched_by").references(() => users.id, { onDelete: "set null" }),
    matchedAt: timestamp("matched_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_bank_matches_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_bank_matches_statement_line").on(t.statementLineId),
    uniqueIndex("uniq_bank_matches_receipt").on(t.receiptId).where(sql`receipt_id IS NOT NULL`),
    uniqueIndex("uniq_bank_matches_payment").on(t.paymentId).where(sql`payment_id IS NOT NULL`),
    uniqueIndex("uniq_bank_matches_journal").on(t.journalId).where(sql`journal_id IS NOT NULL`),
    index("idx_bank_matches_book").on(t.bookId),
    check(
      "ck_bank_matches_counterpart_arc",
      sql`(kind = 'receipt' AND receipt_id IS NOT NULL AND payment_id IS NULL AND journal_id IS NULL)
       OR (kind = 'payment' AND payment_id IS NOT NULL AND receipt_id IS NULL AND journal_id IS NULL)
       OR (kind = 'journal' AND journal_id IS NOT NULL AND receipt_id IS NULL AND payment_id IS NULL)`,
    ),
  ],
);

/* --------------------------------------------------------------- relations */

export const bankProfilesRelations = relations(bankProfiles, ({ one, many }) => ({
  book: one(glBooks, { fields: [bankProfiles.bookId], references: [glBooks.id] }),
  account: one(glAccounts, { fields: [bankProfiles.accountId], references: [glAccounts.id] }),
  statements: many(bankStatements),
}));

export const bankStatementsRelations = relations(bankStatements, ({ one, many }) => ({
  profile: one(bankProfiles, {
    fields: [bankStatements.bankProfileId],
    references: [bankProfiles.id],
  }),
  lines: many(bankStatementLines),
}));

export const bankStatementLinesRelations = relations(bankStatementLines, ({ one }) => ({
  statement: one(bankStatements, {
    fields: [bankStatementLines.statementId],
    references: [bankStatements.id],
  }),
}));

export const bankMatchesRelations = relations(bankMatches, ({ one }) => ({
  statementLine: one(bankStatementLines, {
    fields: [bankMatches.statementLineId],
    references: [bankStatementLines.id],
  }),
  receipt: one(arReceipts, { fields: [bankMatches.receiptId], references: [arReceipts.id] }),
  payment: one(apPayments, { fields: [bankMatches.paymentId], references: [apPayments.id] }),
  journal: one(glJournals, { fields: [bankMatches.journalId], references: [glJournals.id] }),
}));

export type BankProfile = typeof bankProfiles.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankMatch = typeof bankMatches.$inferSelect;
