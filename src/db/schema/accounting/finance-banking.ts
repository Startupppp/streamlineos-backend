import { boolean, date, decimal, foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
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
  ledgerAccountId: integer("ledger_account_id"),
  openingBalance: decimal("opening_balance", { precision: 18, scale: 4 }).default("0").notNull(),
  currentBalance: decimal("current_balance", { precision: 18, scale: 4 }).default("0").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.ledgerAccountId], foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id], name: "fk_fin_bank_accounts_ledger_account_id_org" }),
  unique("uniq_fin_bank_accounts_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_bank_accounts_org_name").on(table.orgId, table.name),
  index("idx_fin_bank_accounts_org_active").on(table.orgId, table.isActive),
]);

export const finBankImports = pgTable("fin_bank_imports", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankAccountId: integer("bank_account_id").notNull(),
  fileName: text("file_name").notNull(),
  format: finBankImportFormatEnum("format").notNull(),
  rowCount: integer("row_count").default(0).notNull(),
  importedCount: integer("imported_count").default(0).notNull(),
  duplicateCount: integer("duplicate_count").default(0).notNull(),
  status: finBankImportStatusEnum("status").default("PENDING").notNull(),
  columnMapping: jsonb("column_mapping"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_fin_bank_imports_created_by_membership" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.bankAccountId], foreignColumns: [finBankAccounts.orgId, finBankAccounts.id], name: "fk_fin_bank_imports_bank_account_id_org" }).onDelete("cascade"),
  unique("uniq_fin_bank_imports_org_id").on(table.orgId, table.id),
  index("idx_fin_bank_imports_org_account").on(table.orgId, table.bankAccountId),
]);

export const finBankTransactions = pgTable("fin_bank_transactions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankAccountId: integer("bank_account_id").notNull(),
  importId: integer("import_id"),
  txnDate: date("txn_date").notNull(),
  description: text("description"),
  reference: text("reference"),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  balanceAfter: decimal("balance_after", { precision: 18, scale: 4 }),
  counterparty: text("counterparty"),
  fingerprint: text("fingerprint").notNull(),
  status: finBankTxnStatusEnum("status").default("UNMATCHED").notNull(),
  matchedJournalEntryId: integer("matched_journal_entry_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.matchedJournalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_fin_bank_transactions_matched_journal_entry_id_org" }),
  foreignKey({ columns: [table.orgId, table.bankAccountId], foreignColumns: [finBankAccounts.orgId, finBankAccounts.id], name: "fk_fin_bank_transactions_bank_account_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.importId], foreignColumns: [finBankImports.orgId, finBankImports.id], name: "fk_fin_bank_transactions_import_id_org" }).onDelete("set null"),
  unique("uniq_fin_bank_transactions_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_bank_txn_org_account_fp").on(table.orgId, table.bankAccountId, table.fingerprint),
  index("idx_fin_bank_txn_org_account_status").on(table.orgId, table.bankAccountId, table.status),
]);

export const finReconciliationMatches = pgTable("fin_reconciliation_matches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  bankTransactionId: integer("bank_transaction_id").notNull(),
  journalEntryId: integer("journal_entry_id"),
  matchedType: finReconMatchTypeEnum("matched_type").notNull(),
  matchedRecordId: integer("matched_record_id"),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  confidence: decimal("confidence", { precision: 5, scale: 2 }),
  isConfirmed: boolean("is_confirmed").default(false).notNull(),
  confirmedByMembershipId: integer("confirmed_by_membership_id"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.confirmedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_fin_recon_matches_confirmed_by_membership" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_fin_reconciliation_matches_journal_entry_id_org" }),
  foreignKey({ columns: [table.orgId, table.bankTransactionId], foreignColumns: [finBankTransactions.orgId, finBankTransactions.id], name: "fk_fin_reconciliation_matches_bank_transaction_id_org" }).onDelete("cascade"),
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
]);

export const finBankTransfers = pgTable("fin_bank_transfers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  fromBankAccountId: integer("from_bank_account_id").notNull(),
  toBankAccountId: integer("to_bank_account_id").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  transferDate: date("transfer_date").notNull(),
  reference: text("reference"),
  journalEntryId: integer("journal_entry_id"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_fin_bank_transfers_created_by_membership" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.fromBankAccountId], foreignColumns: [finBankAccounts.orgId, finBankAccounts.id], name: "fk_fin_bank_transfers_from_bank_account_id_org" }),
  foreignKey({ columns: [table.orgId, table.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_fin_bank_transfers_journal_entry_id_org" }),
  foreignKey({ columns: [table.orgId, table.toBankAccountId], foreignColumns: [finBankAccounts.orgId, finBankAccounts.id], name: "fk_fin_bank_transfers_to_bank_account_id_org" }),
  unique("uniq_fin_bank_transfers_org_id").on(table.orgId, table.id),
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
  creatorMember: one(organizationMembers, { fields: [finBankImports.orgId, finBankImports.createdByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
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
  confirmedByMember: one(organizationMembers, { fields: [finReconciliationMatches.orgId, finReconciliationMatches.confirmedByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
}));

export const finReconciliationRulesRelations = relations(finReconciliationRules, ({ one }) => ({
  organization: one(organizations, { fields: [finReconciliationRules.orgId], references: [organizations.id] }),
}));

export const finBankTransfersRelations = relations(finBankTransfers, ({ one }) => ({
  organization: one(organizations, { fields: [finBankTransfers.orgId], references: [organizations.id] }),
  fromAccount: one(finBankAccounts, { fields: [finBankTransfers.fromBankAccountId], references: [finBankAccounts.id], relationName: "transferFrom" }),
  toAccount: one(finBankAccounts, { fields: [finBankTransfers.toBankAccountId], references: [finBankAccounts.id], relationName: "transferTo" }),
  journalEntry: one(journalEntries, { fields: [finBankTransfers.journalEntryId], references: [journalEntries.id] }),
  creatorMember: one(organizationMembers, { fields: [finBankTransfers.orgId, finBankTransfers.createdByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
}));

