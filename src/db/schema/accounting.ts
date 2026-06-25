import { boolean, date, decimal, foreignKey, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";
import { accountTypeEnum, journalEntryStatusEnum } from "./enums";

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
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.parentAccountId], foreignColumns: [table.id] }).onDelete("set null"),
  unique("uniq_ledger_accounts_org_code").on(table.orgId, table.code),
  index("idx_ledger_accounts_org_type_active").on(table.orgId, table.accountType, table.isActive),
]);

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entryNumber: text("entry_number").notNull(),
  entryDate: date("entry_date").notNull(),
  description: text("description"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  sourceEvent: text("source_event"),
  status: journalEntryStatusEnum("status").default("POSTED").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_je_org_number").on(table.orgId, table.entryNumber),
  unique("uniq_je_idempotency").on(table.orgId, table.sourceType, table.sourceId, table.sourceEvent),
  index("idx_je_org_date").on(table.orgId, table.entryDate),
  index("idx_je_org_source").on(table.orgId, table.sourceType, table.sourceId),
  index("idx_je_org_status").on(table.orgId, table.status),
]);

export const journalLines = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").references(() => journalEntries.id, { onDelete: "cascade" }).notNull(),
  accountId: integer("account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }).notNull(),
  debit: decimal("debit", { precision: 18, scale: 4 }).default("0").notNull(),
  credit: decimal("credit", { precision: 18, scale: 4 }).default("0").notNull(),
  description: text("description"),
  lineOrder: integer("line_order").notNull(),
}, (table) => [
  index("idx_jl_entry").on(table.entryId),
  index("idx_jl_account").on(table.accountId),
]);

export const ledgerAccountsRelations = relations(ledgerAccounts, ({ one, many }) => ({
  organization: one(organizations, { fields: [ledgerAccounts.orgId], references: [organizations.id] }),
  parent: one(ledgerAccounts, { fields: [ledgerAccounts.parentAccountId], references: [ledgerAccounts.id], relationName: "accountParent" }),
  children: many(ledgerAccounts, { relationName: "accountParent" }),
  lines: many(journalLines),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  organization: one(organizations, { fields: [journalEntries.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [journalEntries.createdBy], references: [users.id] }),
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, { fields: [journalLines.entryId], references: [journalEntries.id] }),
  account: one(ledgerAccounts, { fields: [journalLines.accountId], references: [ledgerAccounts.id] }),
}));
