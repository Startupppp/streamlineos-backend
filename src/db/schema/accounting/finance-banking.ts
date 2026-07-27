import { boolean, date, decimal, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { ledgerAccounts, journalEntries } from "./accounting";

export const finBankAccountTypeEnum = pgEnum("fin_bank_account_type", ["BANK", "CASH", "CARD", "WALLET"]);
export const finBankImportFormatEnum = pgEnum("fin_bank_import_format", ["CSV", "OFX", "MANUAL"]);
export const finBankImportStatusEnum = pgEnum("fin_bank_import_status", ["PENDING", "COMPLETED", "FAILED"]);
export const finBankTxnStatusEnum = pgEnum("fin_bank_txn_status", ["UNMATCHED", "SUGGESTED", "MATCHED", "RECONCILED", "IGNORED"]);
export const finReconMatchTypeEnum = pgEnum("fin_recon_match_type", [
  "CUSTOMER_PAYMENT", "VENDOR_PAYMENT", "EXPENSE_REIMBURSEMENT",
  "PAYROLL", "BANK_FEE", "TRANSFER", "MANUAL_JOURNAL",
]);

export const finBankAccounts = pgTable("fin_bank_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  accountType: finBankAccountTypeEnum("account_type").default("BANK").notNull(),
  accountNumberMasked: text("account_number_masked"),
  bankName: text("bank_name"),
  ifsc: text("ifsc"),
  currency: text("currency").default("INR").notNull(),
  ledgerAccountId: integer("ledger_account_id").references(() => ledgerAccounts.id),
  openingBalance: decimal("opening_balance", { precision: 18, scale: 4 }).default("0").notNull(),
  currentBalance: decimal("current_balance", { precision: 18, scale: 4 }).default("0").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_bank_accounts_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_bank_accounts_org_name").on(table.orgId, table.name),
  index("idx_fin_bank_accounts_org_active").on(table.orgId, table.isActive),
]);

export const finBankImports = pgTable("fin_bank_imports", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankAccountId: integer("bank_account_id").references(() => finBankAccounts.id, { onDelete: "cascade" }).notNull(),
  fileName: text("file_name").notNull(),
  format: finBankImportFormatEnum("format").notNull(),
  rowCount: integer("row_count").default(0).notNull(),
  importedCount: integer("imported_count").default(0).notNull(),
  duplicateCount: integer("duplicate_count").default(0).notNull(),
  status: finBankImportStatusEnum("status").default("PENDING").notNull(),
  columnMapping: jsonb("column_mapping"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_bank_imports_org_id").on(table.orgId, table.id),
  index("idx_fin_bank_imports_org_account").on(table.orgId, table.bankAccountId),
]);

export const finBankTransactions = pgTable("fin_bank_transactions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankAccountId: integer("bank_account_id").references(() => finBankAccounts.id, { onDelete: "cascade" }).notNull(),
  importId: integer("import_id").references(() => finBankImports.id, { onDelete: "set null" }),
  txnDate: date("txn_date").notNull(),
  description: text("description"),
  reference: text("reference"),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  balanceAfter: decimal("balance_after", { precision: 18, scale: 4 }),
  counterparty: text("counterparty"),
  fingerprint: text("fingerprint").notNull(),
  status: finBankTxnStatusEnum("status").default("UNMATCHED").notNull(),
  matchedJournalEntryId: integer("matched_journal_entry_id").references(() => journalEntries.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_bank_transactions_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_bank_txn_org_account_fp").on(table.orgId, table.bankAccountId, table.fingerprint),
  index("idx_fin_bank_txn_org_account_status").on(table.orgId, table.bankAccountId, table.status),
  index("idx_fin_bank_txn_org_date").on(table.orgId, table.txnDate),
]);

export const finReconciliationMatches = pgTable("fin_reconciliation_matches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankTransactionId: integer("bank_transaction_id").references(() => finBankTransactions.id, { onDelete: "cascade" }).notNull(),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  matchedType: finReconMatchTypeEnum("matched_type").notNull(),
  matchedRecordId: integer("matched_record_id"),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  confidence: decimal("confidence", { precision: 5, scale: 2 }),
  isConfirmed: boolean("is_confirmed").default(false).notNull(),
  confirmedBy: text("confirmed_by").references(() => users.id),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_recon_matches_org_id").on(table.orgId, table.id),
  index("idx_fin_recon_matches_org_txn").on(table.orgId, table.bankTransactionId),
  index("idx_fin_recon_matches_org_je").on(table.orgId, table.journalEntryId),
]);

export const finReconciliationRules = pgTable("fin_reconciliation_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  priority: integer("priority").default(0).notNull(),
  conditions: jsonb("conditions").notNull(),
  action: jsonb("action").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_recon_rules_org_id").on(table.orgId, table.id),
  index("idx_fin_reconciliation_rules_org_priority").on(table.orgId, table.priority),
]);

export const finBankTransfers = pgTable("fin_bank_transfers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  fromBankAccountId: integer("from_bank_account_id").references(() => finBankAccounts.id).notNull(),
  toBankAccountId: integer("to_bank_account_id").references(() => finBankAccounts.id).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  transferDate: date("transfer_date").notNull(),
  reference: text("reference"),
  journalEntryId: integer("journal_entry_id").references(() => journalEntries.id),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_bank_transfers_org_id").on(table.orgId, table.id),
  index("idx_fin_bank_transfers_org_date").on(table.orgId, table.transferDate),
  index("idx_fin_bank_transfers_from").on(table.fromBankAccountId),
  index("idx_fin_bank_transfers_to").on(table.toBankAccountId),
]);

export const finBankAccountsRelations = relations(finBankAccounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [finBankAccounts.orgId], references: [organizations.id] }),
  ledgerAccount: one(ledgerAccounts, { fields: [finBankAccounts.ledgerAccountId], references: [ledgerAccounts.id] }),
  imports: many(finBankImports),
  transactions: many(finBankTransactions),
}));

export const finBankImportsRelations = relations(finBankImports, ({ one, many }) => ({
  organization: one(organizations, { fields: [finBankImports.orgId], references: [organizations.id] }),
  bankAccount: one(finBankAccounts, { fields: [finBankImports.bankAccountId], references: [finBankAccounts.id] }),
  creator: one(users, { fields: [finBankImports.createdBy], references: [users.id] }),
  transactions: many(finBankTransactions),
}));

export const finBankTransactionsRelations = relations(finBankTransactions, ({ one, many }) => ({
  organization: one(organizations, { fields: [finBankTransactions.orgId], references: [organizations.id] }),
  bankAccount: one(finBankAccounts, { fields: [finBankTransactions.bankAccountId], references: [finBankAccounts.id] }),
  import: one(finBankImports, { fields: [finBankTransactions.importId], references: [finBankImports.id] }),
  journalEntry: one(journalEntries, { fields: [finBankTransactions.matchedJournalEntryId], references: [journalEntries.id] }),
  reconciliationMatches: many(finReconciliationMatches),
}));

export const finReconciliationMatchesRelations = relations(finReconciliationMatches, ({ one }) => ({
  organization: one(organizations, { fields: [finReconciliationMatches.orgId], references: [organizations.id] }),
  bankTransaction: one(finBankTransactions, { fields: [finReconciliationMatches.bankTransactionId], references: [finBankTransactions.id] }),
  journalEntry: one(journalEntries, { fields: [finReconciliationMatches.journalEntryId], references: [journalEntries.id] }),
  confirmedByUser: one(users, { fields: [finReconciliationMatches.confirmedBy], references: [users.id] }),
}));

export const finReconciliationRulesRelations = relations(finReconciliationRules, ({ one }) => ({
  organization: one(organizations, { fields: [finReconciliationRules.orgId], references: [organizations.id] }),
}));

export const finBankTransfersRelations = relations(finBankTransfers, ({ one }) => ({
  organization: one(organizations, { fields: [finBankTransfers.orgId], references: [organizations.id] }),
  fromAccount: one(finBankAccounts, { fields: [finBankTransfers.fromBankAccountId], references: [finBankAccounts.id], relationName: "transferFrom" }),
  toAccount: one(finBankAccounts, { fields: [finBankTransfers.toBankAccountId], references: [finBankAccounts.id], relationName: "transferTo" }),
  journalEntry: one(journalEntries, { fields: [finBankTransfers.journalEntryId], references: [journalEntries.id] }),
  creator: one(users, { fields: [finBankTransfers.createdBy], references: [users.id] }),
}));

export type FinBankAccount = typeof finBankAccounts.$inferSelect;
export type NewFinBankAccount = typeof finBankAccounts.$inferInsert;
export type FinBankImport = typeof finBankImports.$inferSelect;
export type FinBankTransaction = typeof finBankTransactions.$inferSelect;
export type FinReconciliationMatch = typeof finReconciliationMatches.$inferSelect;
export type FinReconciliationRule = typeof finReconciliationRules.$inferSelect;
export type FinBankTransfer = typeof finBankTransfers.$inferSelect;
