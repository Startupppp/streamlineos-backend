import { boolean, date, decimal, index, integer, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { glAccounts, glJournals } from "./gl-kernel";
import { expenseCategories } from "../hr/payroll";

/**
 * Employee reimbursement batches and expense policies.
 *
 * These two tables belong to HR self-service (`modules/expenses`), not to the
 * accounting bounded context — they only ever *referenced* the ledger. When the
 * pre-rewrite accounting schema was retired in 0466 they were dropped with it;
 * 0467 recreates them against the new kernel.
 *
 * The two ledger references moved rather than disappeared:
 *   `journal_entry_id integer -> journal_entries`  becomes  `posted_journal_id text -> gl_journals`
 *   `bank_account_id  integer -> fin_bank_accounts` becomes `cash_account_id  text -> gl_accounts`
 *
 * A bank is no longer a table of its own: it is a `gl_accounts` row with
 * `is_cash = true`, with the sort-code/IBAN metadata hanging off `bank_profiles`
 * (db/schema/accounting/banking.ts). Pointing at the GL account is therefore the
 * faithful translation, not a downgrade.
 */

export const finReimbursementBatchStatusEnum = pgEnum("fin_reimbursement_batch_status", ["DRAFT", "APPROVED", "PAID"]);

export const finReimbursementBatches = pgTable("fin_reimbursement_batches", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  status: finReimbursementBatchStatusEnum("status").default("DRAFT").notNull(),
  totalAmount: decimal("total_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  paidDate: date("paid_date"),
  /** The kernel journal this batch's disbursement posted as. */
  postedJournalId: text("posted_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
  /** The cash/bank GL account the batch was paid from (`gl_accounts.is_cash`). */
  cashAccountId: text("cash_account_id").references(() => glAccounts.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_reimbursement_batches_org_id").on(table.orgId, table.id),
  index("idx_fin_reimbursement_batches_org_status").on(table.orgId, table.status),
]);

export const finExpensePolicies = pgTable("fin_expense_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  categoryId: integer("category_id").references(() => expenseCategories.id, { onDelete: "set null" }),
  maxAmount: decimal("max_amount", { precision: 12, scale: 2 }),
  requiresReceiptAbove: decimal("requires_receipt_above", { precision: 12, scale: 2 }),
  requiresApprovalAbove: decimal("requires_approval_above", { precision: 12, scale: 2 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_expense_policies_org_id").on(table.orgId, table.id),
  index("idx_fin_expense_policies_org").on(table.orgId),
]);

export const finReimbursementBatchesRelations = relations(finReimbursementBatches, ({ one }) => ({
  organization: one(organizations, { fields: [finReimbursementBatches.orgId], references: [organizations.id] }),
  postedJournal: one(glJournals, { fields: [finReimbursementBatches.postedJournalId], references: [glJournals.id] }),
  cashAccount: one(glAccounts, { fields: [finReimbursementBatches.cashAccountId], references: [glAccounts.id] }),
  creator: one(users, { fields: [finReimbursementBatches.createdBy], references: [users.id], relationName: "batchCreatedBy" }),
  approver: one(users, { fields: [finReimbursementBatches.approvedBy], references: [users.id], relationName: "batchApprovedBy" }),
}));

export const finExpensePoliciesRelations = relations(finExpensePolicies, ({ one }) => ({
  organization: one(organizations, { fields: [finExpensePolicies.orgId], references: [organizations.id] }),
  category: one(expenseCategories, { fields: [finExpensePolicies.categoryId], references: [expenseCategories.id] }),
}));
