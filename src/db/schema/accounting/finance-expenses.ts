import { boolean, date, decimal, foreignKey, index, integer, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { journalEntries } from "./accounting";
import { expenseCategories } from "../payroll/claims-and-settlements";
import { finBankAccounts } from "./finance-banking";

export const finReimbursementBatchStatusEnum = pgEnum("fin_reimbursement_batch_status", ["DRAFT", "APPROVED", "PAID"]);

export const finReimbursementBatches = pgTable("fin_reimbursement_batches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  status: finReimbursementBatchStatusEnum("status").default("DRAFT").notNull(),
  totalAmount: decimal("total_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  paidDate: date("paid_date"),
  journalEntryId: integer("journal_entry_id"),
  bankAccountId: integer("bank_account_id"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: "fk_fin_reimbursement_batches_journal_entry_id_org" }),
  foreignKey({ columns: [table.orgId, table.bankAccountId], foreignColumns: [finBankAccounts.orgId, finBankAccounts.id], name: "fk_fin_reimbursement_batches_bank_account_id_org" }),
  unique("uniq_fin_reimbursement_batches_org_id").on(table.orgId, table.id),
  index("idx_fin_reimbursement_batches_org_status").on(table.orgId, table.status),
]);

export const finExpensePolicies = pgTable("fin_expense_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  categoryId: integer("category_id"),
  maxAmount: decimal("max_amount", { precision: 12, scale: 2 }),
  requiresReceiptAbove: decimal("requires_receipt_above", { precision: 12, scale: 2 }),
  requiresApprovalAbove: decimal("requires_approval_above", { precision: 12, scale: 2 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.categoryId], foreignColumns: [expenseCategories.orgId, expenseCategories.id], name: "fk_fin_expense_policies_category_id_org" }).onDelete("set null"),
  unique("uniq_fin_expense_policies_org_id").on(table.orgId, table.id),
  index("idx_fin_expense_policies_org").on(table.orgId),
]);

export const finReimbursementBatchesRelations = relations(finReimbursementBatches, ({ one }) => ({
  organization: one(organizations, { fields: [finReimbursementBatches.orgId], references: [organizations.id] }),
  journalEntry: one(journalEntries, { fields: [finReimbursementBatches.journalEntryId], references: [journalEntries.id] }),
  creator: one(users, { fields: [finReimbursementBatches.createdBy], references: [users.id], relationName: "batchCreatedBy" }),
  approver: one(users, { fields: [finReimbursementBatches.approvedBy], references: [users.id], relationName: "batchApprovedBy" }),
}));

export const finExpensePoliciesRelations = relations(finExpensePolicies, ({ one }) => ({
  organization: one(organizations, { fields: [finExpensePolicies.orgId], references: [organizations.id] }),
  category: one(expenseCategories, { fields: [finExpensePolicies.categoryId], references: [expenseCategories.id] }),
}));

