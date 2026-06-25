import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  payrollStatusEnum, expenseStatusEnum, assetStatusEnum,
  reimbursementStatusEnum, loanStatusEnum, bonusTypeEnum, fnfStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { projects } from "../projects";
import { resignations } from "./offboarding";
import { assets } from "./assets";

export const payrolls = pgTable("payrolls", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  month: text("month").notNull(),
  basicSalary: decimal("basic_salary", { precision: 15, scale: 2 }).notNull(),
  hra: decimal("hra", { precision: 15, scale: 2 }).default("0").notNull(),
  allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0").notNull(),
  deductions: decimal("deductions", { precision: 15, scale: 2 }).default("0").notNull(),
  grossSalary: decimal("gross_salary", { precision: 15, scale: 2 }).notNull(),
  netSalary: decimal("net_salary", { precision: 15, scale: 2 }).notNull(),
  status: payrollStatusEnum("status").default("DRAFT").notNull(),
  generatedBy: text("generated_by").references(() => users.id, { onDelete: "set null" }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  overtimeType: text("overtime_type"),
  overtimeDays: decimal("overtime_days", { precision: 6, scale: 2 }).default("0").notNull(),
  overtimeHours: decimal("overtime_hours", { precision: 6, scale: 2 }).default("0").notNull(),
  overtimeAmount: decimal("overtime_amount", { precision: 15, scale: 2 }).default("0").notNull(),
  payslipUrl: text("payslip_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_payrolls_user_month").on(table.userId, table.month),
  index("idx_payrolls_org_month_status").on(table.orgId, table.month, table.status),
]);

export const salaryStructures = pgTable("salary_structures", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  basicSalary: decimal("basic_salary", { precision: 15, scale: 2 }).notNull(),
  hraPercentage: decimal("hra_percentage", { precision: 5, scale: 2 }).default("40").notNull(),
  allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0").notNull(),
  deductions: decimal("deductions", { precision: 15, scale: 2 }).default("0").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_salary_structures_user_active").on(table.userId, table.isActive),
]);

export const expenseCategories = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  budgetLimit: decimal("budget_limit", { precision: 15, scale: 2 }),
  budgetPeriod: text("budget_period").default("MONTHLY").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_expense_categories_org_name").on(table.orgId, table.name),
]);

export const expenses = pgTable("expenses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => expenseCategories.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  currency: text("currency").default("INR").notNull(),
  description: text("description"),
  receiptUrl: text("receipt_url"),
  receiptFileName: text("receipt_file_name"),
  merchant: text("merchant"),
  paymentMethod: text("payment_method"),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  status: expenseStatusEnum("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  paidAt: timestamp("paid_at"),
  transactionRef: text("transaction_ref"),
  expenseDate: date("expense_date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_expenses_user_id").on(table.userId),
  index("idx_expenses_org_status_date").on(table.orgId, table.status, table.expenseDate),
  index("idx_expenses_category").on(table.categoryId),
]);

export const reimbursements = pgTable("reimbursements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  category: text("category").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  description: text("description"),
  receiptUrl: text("receipt_url"),
  status: reimbursementStatusEnum("status").default("PENDING").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  paidAt: timestamp("paid_at"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_reimbursements_org").on(table.orgId),
  index("idx_reimbursements_user").on(table.userId),
]);

export const salaryLoans = pgTable("salary_loans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  reason: text("reason"),
  emiAmount: decimal("emi_amount", { precision: 15, scale: 2 }),
  totalEmis: integer("total_emis"),
  paidEmis: integer("paid_emis").default(0).notNull(),
  status: loanStatusEnum("status").default("PENDING").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  disbursedAt: timestamp("disbursed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_loans_org").on(table.orgId),
  index("idx_loans_user").on(table.userId),
]);

export const bonuses = pgTable("bonuses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type: bonusTypeEnum("type").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  reason: text("reason"),
  month: text("month"),
  status: text("status").default("PENDING").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_bonuses_user").on(table.userId),
]);

export const fnfSettlements = pgTable("fnf_settlements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  resignationId: integer("resignation_id").references(() => resignations.id, { onDelete: "set null" }),
  basicDues: decimal("basic_dues", { precision: 15, scale: 2 }).default("0").notNull(),
  leaveEncashment: decimal("leave_encashment", { precision: 15, scale: 2 }).default("0").notNull(),
  bonusDue: decimal("bonus_due", { precision: 15, scale: 2 }).default("0").notNull(),
  deductions: decimal("deductions", { precision: 15, scale: 2 }).default("0").notNull(),
  loanRecovery: decimal("loan_recovery", { precision: 15, scale: 2 }).default("0").notNull(),
  netPayable: decimal("net_payable", { precision: 15, scale: 2 }).default("0").notNull(),
  status: fnfStatusEnum("status").default("DRAFT").notNull(),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_fnf_user").on(table.userId),
]);

export const assetReturns = pgTable("asset_returns", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  assetId: integer("asset_id").references(() => assets.id),
  assetName: text("asset_name").notNull(),
  status: text("status").default("PENDING").notNull(),
  returnedAt: timestamp("returned_at"),
  condition: text("condition"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_asset_returns_user").on(table.userId),
]);

export const payrollsRelations = relations(payrolls, ({ one }) => ({
  user: one(users, { fields: [payrolls.userId], references: [users.id] }),
  generatedByUser: one(users, { fields: [payrolls.generatedBy], references: [users.id], relationName: "payrollGeneratedBy" }),
  approvedByUser: one(users, { fields: [payrolls.approvedBy], references: [users.id], relationName: "payrollApprovedBy" }),
}));

export const salaryStructuresRelations = relations(salaryStructures, ({ one }) => ({
  user: one(users, { fields: [salaryStructures.userId], references: [users.id] }),
}));

export const expenseCategoriesRelations = relations(expenseCategories, ({ many }) => ({
  expenses: many(expenses),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  user: one(users, { fields: [expenses.userId], references: [users.id], relationName: "expenseUser" }),
  approver: one(users, { fields: [expenses.approverId], references: [users.id], relationName: "expenseApprover" }),
  expenseCategory: one(expenseCategories, { fields: [expenses.categoryId], references: [expenseCategories.id] }),
  project: one(projects, { fields: [expenses.projectId], references: [projects.id] }),
}));

export const reimbursementsRelations = relations(reimbursements, ({ one }) => ({
  user: one(users, { fields: [reimbursements.userId], references: [users.id] }),
  approver: one(users, { fields: [reimbursements.approvedBy], references: [users.id], relationName: "reimbursementApprover" }),
}));

export const salaryLoansRelations = relations(salaryLoans, ({ one }) => ({
  user: one(users, { fields: [salaryLoans.userId], references: [users.id] }),
  approver: one(users, { fields: [salaryLoans.approvedBy], references: [users.id], relationName: "loanApprover" }),
}));

export const bonusesRelations = relations(bonuses, ({ one }) => ({
  user: one(users, { fields: [bonuses.userId], references: [users.id] }),
  approver: one(users, { fields: [bonuses.approvedBy], references: [users.id], relationName: "bonusApprover" }),
}));

export const fnfSettlementsRelations = relations(fnfSettlements, ({ one }) => ({
  user: one(users, { fields: [fnfSettlements.userId], references: [users.id] }),
  resignation: one(resignations, { fields: [fnfSettlements.resignationId], references: [resignations.id] }),
}));

export const assetReturnsRelations = relations(assetReturns, ({ one }) => ({
  user: one(users, { fields: [assetReturns.userId], references: [users.id] }),
  asset: one(assets, { fields: [assetReturns.assetId], references: [assets.id] }),
}));
