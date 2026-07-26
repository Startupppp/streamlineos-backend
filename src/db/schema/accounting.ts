import { boolean, date, decimal, foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";
import { accountTypeEnum, journalEntryStatusEnum } from "./enums";

export const accNormalBalanceEnum = pgEnum("acc_normal_balance", ["DEBIT", "CREDIT"]);

export const indianStates = pgTable("indian_states", {
  stateCode: text("state_code").primaryKey(),
  stateName: text("state_name").notNull(),
  gstStateCode: text("gst_state_code").notNull(),
});

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  accountType: accountTypeEnum("account_type").notNull(),
  parentAccountId: integer("parent_account_id"),
  isActive: boolean("is_active").default(true).notNull(),
  normalBalance: accNormalBalanceEnum("normal_balance"),
  isSystem: boolean("is_system").default(false).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_ledger_accounts_org_id").on(table.orgId, table.id),
  foreignKey({ columns: [table.parentAccountId], foreignColumns: [table.id] }).onDelete("set null"),
  unique("uniq_ledger_accounts_org_code").on(table.orgId, table.code),
  index("idx_ledger_accounts_org_type_active").on(table.orgId, table.accountType, table.isActive),
]);

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entryNumber: text("entry_number").notNull(),
  entryDate: date("entry_date").notNull(),
  postingDate: date("posting_date"),
  description: text("description"),
  periodId: integer("period_id"),
  currency: text("currency").default("INR").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  sourceEvent: text("source_event"),
  status: journalEntryStatusEnum("status").default("POSTED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  postedBy: text("posted_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  reversedEntryId: integer("reversed_entry_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_journal_entries_org_id").on(table.orgId, table.id),
  unique("uniq_je_org_number").on(table.orgId, table.entryNumber),
  unique("uniq_je_idempotency").on(table.orgId, table.sourceType, table.sourceId, table.sourceEvent),
  index("idx_je_org_date").on(table.orgId, table.entryDate),
  index("idx_je_org_source").on(table.orgId, table.sourceType, table.sourceId),
  index("idx_je_org_status").on(table.orgId, table.status),
  foreignKey({ columns: [table.reversedEntryId], foreignColumns: [table.id] }).onDelete("set null"),
]);

export const journalLines = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").references(() => journalEntries.id, { onDelete: "cascade" }).notNull(),
  accountId: integer("account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  debit: decimal("debit", { precision: 18, scale: 4 }).default("0").notNull(),
  credit: decimal("credit", { precision: 18, scale: 4 }).default("0").notNull(),
  description: text("description"),
  lineOrder: integer("line_order").notNull(),
  currency: text("currency"),
  exchangeRate: decimal("exchange_rate", { precision: 18, scale: 8 }),
  baseDebit: decimal("base_debit", { precision: 18, scale: 4 }),
  baseCredit: decimal("base_credit", { precision: 18, scale: 4 }),
  clientId: integer("client_id"),
  vendorId: integer("vendor_id"),
  projectId: integer("project_id"),
  departmentId: integer("department_id"),
  employeeId: integer("employee_id"),
  taxCodeId: integer("tax_code_id"),
  dimensionValues: jsonb("dimension_values"),
}, (table) => [
  index("idx_jl_entry").on(table.entryId),
  index("idx_jl_account").on(table.accountId),
  index("idx_jl_org_account").on(table.orgId, table.accountId),
]);

export const ledgerAccountsRelations = relations(ledgerAccounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [ledgerAccounts.orgId], references: [organizations.id] }),
  parent: one(ledgerAccounts, { fields: [ledgerAccounts.parentAccountId], references: [ledgerAccounts.id], relationName: "accountParent" }),
  children: many(ledgerAccounts, { relationName: "accountParent" }),
  lines: many(journalLines),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  organization: one(organizations, { fields: [journalEntries.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [journalEntries.createdBy], references: [users.id], relationName: "jeCreatedBy" }),
  approver: one(users, { fields: [journalEntries.approvedBy], references: [users.id], relationName: "jeApprovedBy" }),
  poster: one(users, { fields: [journalEntries.postedBy], references: [users.id], relationName: "jePostedBy" }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, { fields: [journalLines.entryId], references: [journalEntries.id] }),
  account: one(ledgerAccounts, { fields: [journalLines.accountId], references: [ledgerAccounts.id] }),
  organization: one(organizations, { fields: [journalLines.orgId], references: [organizations.id] }),
}));

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
