import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  payrollRunStatusEnum, payrollWorkerTypeEnum, salaryComponentTypeEnum,
  salaryComponentCalcMethodEnum, payrollExceptionSeverityEnum,
  payrollExceptionStatusEnum, payrollApprovalStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { payrollPolicyVersions } from "./payroll-policies";

export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  policyVersionId: integer("policy_version_id").references(() => payrollPolicyVersions.id, { onDelete: "set null" }),
  month: text("month").notNull(),
  /** REGULAR | BONUS | OFF_CYCLE | CORRECTION | FINAL_SETTLEMENT */
  runType: text("run_type").default("REGULAR").notNull(),
  /** Source period/run for off-cycle, correction, F&F */
  sourcePeriodKey: text("source_period_key"),
  sourceRunId: integer("source_run_id"),
  entityId: integer("entity_id"),
  periodId: integer("period_id"),
  calculationVersion: text("calculation_version").default("1.0.0"),
  statutoryRuleVersion: text("statutory_rule_version"),
  inputSnapshotHash: text("input_snapshot_hash"),
  status: payrollRunStatusEnum("status").default("PREPARING").notNull(),
  payDate: date("pay_date"),
  grossTotal: decimal("gross_total", { precision: 15, scale: 2 }).default("0").notNull(),
  deductionTotal: decimal("deduction_total", { precision: 15, scale: 2 }).default("0").notNull(),
  employerCostTotal: decimal("employer_cost_total", { precision: 15, scale: 2 }).default("0").notNull(),
  netTotal: decimal("net_total", { precision: 15, scale: 2 }).default("0").notNull(),
  employeeCount: integer("employee_count").default(0).notNull(),
  exceptionCount: integer("exception_count").default(0).notNull(),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  paidAt: timestamp("paid_at"),
  paidBy: text("paid_by").references(() => users.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at"),
  closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
  reopenedAt: timestamp("reopened_at"),
  reopenedBy: text("reopened_by").references(() => users.id, { onDelete: "set null" }),
  reopenReason: text("reopen_reason"),
  /** Soft processing lock for generate/recalculate concurrency (token + timestamp). */
  generationLockToken: text("generation_lock_token"),
  generationLockedAt: timestamp("generation_locked_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  // One run per (org, month, runType, entity). NULL entity → COALESCE 0 (org-level bucket).
  // Migration 0298 replaces uniq_payroll_runs_org_month_type.
  uniqueIndex("uniq_payroll_runs_org_month_type_entity").on(
    table.orgId,
    table.month,
    table.runType,
    sql`COALESCE(${table.entityId}, 0)`,
  ),
  index("idx_payroll_runs_org_status").on(table.orgId, table.status),
  index("idx_payroll_runs_org_type").on(table.orgId, table.runType),
  index("idx_payroll_runs_org_entity").on(table.orgId, table.entityId),
  index("idx_payroll_runs_source_run").on(table.sourceRunId),
]);

export const payrollRunEmployees = pgTable("payroll_run_employees", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  profileId: integer("profile_id"),
  workerType: payrollWorkerTypeEnum("worker_type").default("EMPLOYEE").notNull(),
  currency: text("currency").default("INR").notNull(),
  payoutCurrency: text("payout_currency"),
  fxRate: decimal("fx_rate", { precision: 12, scale: 6 }),
  scheduledDays: decimal("scheduled_days", { precision: 5, scale: 1 }).default("0").notNull(),
  paidDays: decimal("paid_days", { precision: 5, scale: 1 }).default("0").notNull(),
  lopDays: decimal("lop_days", { precision: 5, scale: 1 }).default("0").notNull(),
  overtimeHours: decimal("overtime_hours", { precision: 6, scale: 2 }).default("0").notNull(),
  gross: decimal("gross", { precision: 15, scale: 2 }).default("0").notNull(),
  totalDeductions: decimal("total_deductions", { precision: 15, scale: 2 }).default("0").notNull(),
  employerContributions: decimal("employer_contributions", { precision: 15, scale: 2 }).default("0").notNull(),
  net: decimal("net", { precision: 15, scale: 2 }).default("0").notNull(),
  netPayoutCurrency: decimal("net_payout_currency", { precision: 15, scale: 2 }),
  status: text("status").default("PENDING").notNull(),
  holdReason: text("hold_reason"),
  inputsSnapshot: jsonb("inputs_snapshot").$type<object>(),
  calculationSnapshot: jsonb("calculation_snapshot").$type<object>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_payroll_run_employees_run_user").on(table.runId, table.userId),
  index("idx_payroll_run_employees_org_run").on(table.orgId, table.runId),
]);

export const payrollLineItems = pgTable("payroll_line_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  runEmployeeId: integer("run_employee_id").references(() => payrollRunEmployees.id, { onDelete: "cascade" }).notNull(),
  componentId: integer("component_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: salaryComponentTypeEnum("category").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  calcMethod: salaryComponentCalcMethodEnum("calc_method").notNull(),
  calcExplain: jsonb("calc_explain").$type<object>().notNull(),
  taxable: boolean("taxable").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_payroll_line_items_run_employee").on(table.runEmployeeId),
  index("idx_payroll_line_items_org_run").on(table.orgId, table.runId),
]);

export const payrollExceptions = pgTable("payroll_exceptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  runEmployeeId: integer("run_employee_id").references(() => payrollRunEmployees.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  code: text("code").notNull(),
  severity: payrollExceptionSeverityEnum("severity").notNull(),
  status: payrollExceptionStatusEnum("status").default("OPEN").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at"),
  overrideReason: text("override_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_payroll_exceptions_org_run_status").on(table.orgId, table.runId, table.status),
]);

export const payrollApprovals = pgTable("payroll_approvals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "cascade" }).notNull(),
  stage: integer("stage").notNull(),
  stageName: text("stage_name").notNull(),
  requiredPermission: text("required_permission").notNull(),
  status: payrollApprovalStatusEnum("status").default("PENDING").notNull(),
  actedBy: text("acted_by").references(() => users.id, { onDelete: "set null" }),
  actedAt: timestamp("acted_at"),
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_payroll_approvals_run_stage").on(table.runId, table.stage),
  index("idx_payroll_approvals_org_run").on(table.orgId, table.runId),
]);

export const payrollRunsRelations = relations(payrollRuns, ({ one, many }) => ({
  policyVersion: one(payrollPolicyVersions, { fields: [payrollRuns.policyVersionId], references: [payrollPolicyVersions.id] }),
  employees: many(payrollRunEmployees),
  exceptions: many(payrollExceptions),
  approvals: many(payrollApprovals),
  createdByUser: one(users, { fields: [payrollRuns.createdBy], references: [users.id], relationName: "runCreatedBy" }),
  lockedByUser: one(users, { fields: [payrollRuns.lockedBy], references: [users.id], relationName: "runLockedBy" }),
}));

export const payrollRunEmployeesRelations = relations(payrollRunEmployees, ({ one, many }) => ({
  run: one(payrollRuns, { fields: [payrollRunEmployees.runId], references: [payrollRuns.id] }),
  user: one(users, { fields: [payrollRunEmployees.userId], references: [users.id] }),
  lineItems: many(payrollLineItems),
  exceptions: many(payrollExceptions),
}));

export const payrollLineItemsRelations = relations(payrollLineItems, ({ one }) => ({
  runEmployee: one(payrollRunEmployees, { fields: [payrollLineItems.runEmployeeId], references: [payrollRunEmployees.id] }),
  run: one(payrollRuns, { fields: [payrollLineItems.runId], references: [payrollRuns.id] }),
}));

export const payrollExceptionsRelations = relations(payrollExceptions, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollExceptions.runId], references: [payrollRuns.id] }),
  runEmployee: one(payrollRunEmployees, { fields: [payrollExceptions.runEmployeeId], references: [payrollRunEmployees.id] }),
  user: one(users, { fields: [payrollExceptions.userId], references: [users.id] }),
}));

export const payrollApprovalsRelations = relations(payrollApprovals, ({ one }) => ({
  run: one(payrollRuns, { fields: [payrollApprovals.runId], references: [payrollRuns.id] }),
  actedByUser: one(users, { fields: [payrollApprovals.actedBy], references: [users.id], relationName: "approvalActedBy" }),
}));
