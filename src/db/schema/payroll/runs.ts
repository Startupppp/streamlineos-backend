import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, unique, foreignKey, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  payrollRunStatusEnum, payrollWorkerTypeEnum, salaryComponentTypeEnum,
  salaryComponentCalcMethodEnum, payrollExceptionSeverityEnum,
  payrollExceptionStatusEnum, payrollApprovalStatusEnum,
} from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { workers } from "../directory/workers";
import { payrollPolicyVersions } from "./policies";
import { hrPayrollInputPeriods } from "./input-capture";

export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  policyVersionId: integer("policy_version_id"),
  month: text("month").notNull(),
  /** REGULAR | BONUS | OFF_CYCLE | CORRECTION | FINAL_SETTLEMENT */
  runType: text("run_type").default("REGULAR").notNull(),
  /** Source period/run for off-cycle, correction, F&F */
  sourcePeriodKey: text("source_period_key"),
  sourceRunId: integer("source_run_id").references((): AnyPgColumn => payrollRuns.id, { onDelete: "set null" }),
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
  lockedByMembershipId: integer("locked_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  paidAt: timestamp("paid_at"),
  paidBy: text("paid_by").references(() => users.id, { onDelete: "set null" }),
  paidByMembershipId: integer("paid_by_membership_id"),
  publishedAt: timestamp("published_at"),
  publishedBy: text("published_by").references(() => users.id, { onDelete: "set null" }),
  publishedByMembershipId: integer("published_by_membership_id"),
  closedAt: timestamp("closed_at"),
  closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
  closedByMembershipId: integer("closed_by_membership_id"),
  reopenedAt: timestamp("reopened_at"),
  reopenedBy: text("reopened_by").references(() => users.id, { onDelete: "set null" }),
  reopenedByMembershipId: integer("reopened_by_membership_id"),
  reopenReason: text("reopen_reason"),
  postingState: text("posting_state").notNull().default("pending").$type<"pending" | "posted" | "failed">(),
  /** Soft processing lock for generate/recalculate concurrency (token + timestamp). */
  generationLockToken: text("generation_lock_token"),
  generationLockedAt: timestamp("generation_locked_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.periodId], foreignColumns: [hrPayrollInputPeriods.orgId, hrPayrollInputPeriods.id], name: "fk_payroll_runs_period_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.policyVersionId], foreignColumns: [payrollPolicyVersions.orgId, payrollPolicyVersions.id], name: "fk_payroll_runs_policy_version_id_org" }).onDelete("set null"),
  unique("uniq_payroll_runs_org_id").on(table.orgId, table.id),
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
  index("idx_payroll_runs_org_approved_actor").on(table.orgId, table.approvedByMembershipId),
  index("idx_payroll_runs_org_paid_actor").on(table.orgId, table.paidByMembershipId),
  index("idx_payroll_runs_org_published_actor").on(table.orgId, table.publishedByMembershipId),
  index("idx_payroll_runs_org_closed_actor").on(table.orgId, table.closedByMembershipId),
  index("idx_payroll_runs_org_reopened_actor").on(table.orgId, table.reopenedByMembershipId),
  index("idx_payroll_runs_org_created_actor").on(table.orgId, table.createdByMembershipId),
  index("idx_payroll_runs_org_locked_actor").on(table.orgId, table.lockedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_approved_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.paidByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_paid_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.publishedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_published_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.closedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_closed_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.reopenedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_reopened_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_created_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.lockedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_runs_locked_actor",
  }).onDelete("set null"),
]);

export const payrollRunEmployees = pgTable("payroll_run_employees", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").notNull(),
  userId: text("user_id"),
  userMembershipId: integer("user_membership_id"),
  workerId: text("worker_id"),
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
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id], name: "fk_payroll_run_employees_org_run" }).onDelete("cascade"),
  unique("uniq_payroll_run_employees_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_run_employees_run_user").on(table.runId, table.userId),
  uniqueIndex("uniq_payroll_run_employees_run_worker")
    .on(table.runId, table.workerId)
    .where(sql`worker_id IS NOT NULL`),
  index("idx_payroll_run_employees_org_run").on(table.orgId, table.runId),
  index("idx_payroll_run_employees_org_worker").on(table.orgId, table.workerId),
  index("idx_payroll_run_employees_org_user_actor").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_run_employees_user_actor",
  }).onDelete("set null"),
  check(
    "chk_payroll_run_employees_subject",
    sql`user_id IS NOT NULL OR worker_id IS NOT NULL`,
  ),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_payroll_run_employees_org_worker",
  }).onDelete("set null"),
]);

export const payrollLineItems = pgTable("payroll_line_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").notNull(),
  runEmployeeId: integer("run_employee_id").notNull(),
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
  foreignKey({ columns: [table.orgId, table.runEmployeeId], foreignColumns: [payrollRunEmployees.orgId, payrollRunEmployees.id], name: "fk_payroll_line_items_run_employee_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id], name: "fk_payroll_line_items_run_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_line_items_org_id").on(table.orgId, table.id),
  index("idx_payroll_line_items_run_employee").on(table.runEmployeeId),
  index("idx_payroll_line_items_org_run").on(table.orgId, table.runId),
]);

export const payrollExceptions = pgTable("payroll_exceptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").notNull(),
  runEmployeeId: integer("run_employee_id"),
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
  foreignKey({ columns: [table.orgId, table.runEmployeeId], foreignColumns: [payrollRunEmployees.orgId, payrollRunEmployees.id], name: "fk_payroll_exceptions_run_employee_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id], name: "fk_payroll_exceptions_run_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_exceptions_org_id").on(table.orgId, table.id),
  index("idx_payroll_exceptions_org_run_status").on(table.orgId, table.runId, table.status),
]);

export const payrollApprovals = pgTable("payroll_approvals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").notNull(),
  stage: integer("stage").notNull(),
  stageName: text("stage_name").notNull(),
  requiredPermission: text("required_permission").notNull(),
  status: payrollApprovalStatusEnum("status").default("PENDING").notNull(),
  actedByMembershipId: integer("acted_by_membership_id"),
  actedAt: timestamp("acted_at"),
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id], name: "fk_payroll_approvals_run_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_approvals_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_approvals_run_stage").on(table.runId, table.stage),
  index("idx_payroll_approvals_org_run").on(table.orgId, table.runId),
  index("idx_payroll_approvals_org_acted_actor").on(table.orgId, table.actedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.actedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_payroll_approvals_acted_actor",
  }).onDelete("set null"),
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
  worker: one(workers, { fields: [payrollRunEmployees.workerId], references: [workers.workerId] }),
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
}));
