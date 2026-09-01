import { pgTable, text, serial, timestamp, boolean, decimal, date, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  salaryComponentTypeEnum, salaryComponentCalcMethodEnum,
  payrollWorkerTypeEnum, payFrequencyEnum, taxRegimeTypeEnum,
  salaryProfileStatusEnum, payrollLoanAdjustmentTypeEnum,
} from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { workers } from "../directory/workers";
import { salaryLoans } from "./claims-and-settlements";
import { payrollRuns } from "./runs";
import { payrollPolicyVersions } from "./policies";

export const salaryComponents = pgTable("salary_components", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: salaryComponentTypeEnum("type").notNull(),
  calcMethod: salaryComponentCalcMethodEnum("calc_method").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }),
  percent: decimal("percent", { precision: 7, scale: 4 }),
  formula: text("formula"),
  taxable: boolean("taxable").default(false).notNull(),
  showOnPayslip: boolean("show_on_payslip").default(true).notNull(),
  includeInCtc: boolean("include_in_ctc").default(true).notNull(),
  isStatutory: boolean("is_statutory").default(false).notNull(),
  statutoryKey: text("statutory_key"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_salary_components_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_salary_components_org_code").on(table.orgId, table.code),
  index("idx_salary_components_org_active").on(table.orgId, table.isActive),
]);

export const employeeSalaryProfiles = pgTable("employee_salary_profiles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id"),
  workerId: text("worker_id"),
  workerType: payrollWorkerTypeEnum("worker_type").default("EMPLOYEE").notNull(),
  payFrequency: payFrequencyEnum("pay_frequency").default("MONTHLY").notNull(),
  currency: text("currency").default("INR").notNull(),
  payoutCurrency: text("payout_currency"),
  fxSource: text("fx_source"),
  taxRegime: taxRegimeTypeEnum("tax_regime"),
  costCenter: text("cost_center"),
  annualCtc: decimal("annual_ctc", { precision: 15, scale: 2 }).notNull(),
  basicSalary: decimal("basic_salary", { precision: 15, scale: 2 }),
  hraPercentage: decimal("hra_percentage", { precision: 5, scale: 2 }),
  allowances: decimal("allowances", { precision: 15, scale: 2 }).default("0").notNull(),
  deductions: decimal("deductions", { precision: 15, scale: 2 }).default("0").notNull(),
  status: salaryProfileStatusEnum("status").default("ACTIVE").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  userMembershipId: integer("user_membership_id"),
  policyVersionId: integer("policy_version_id").references(() => payrollPolicyVersions.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_employee_salary_profiles_org_id").on(table.orgId, table.id),
  index("idx_employee_salary_profiles_org_user_effective").on(table.orgId, table.userId, table.effectiveFrom),
  index("idx_employee_salary_profiles_org_worker").on(table.orgId, table.workerId),
  index("idx_employee_salary_profiles_org_status").on(table.orgId, table.status),
  index("idx_employee_salary_profiles_org_user_actor").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_employee_salary_profiles_user_actor",
  }).onDelete("set null"),
  uniqueIndex("uniq_esp_org_user_effective_from").on(table.orgId, table.userId, table.effectiveFrom),
  uniqueIndex("uniq_esp_org_worker_effective_from")
    .on(table.orgId, table.workerId, table.effectiveFrom)
    .where(sql`worker_id IS NOT NULL`),
  check(
    "chk_employee_salary_profiles_subject",
    sql`user_id IS NOT NULL OR worker_id IS NOT NULL`,
  ),
  foreignKey({
    columns: [table.orgId, table.workerId],
    foreignColumns: [workers.organizationId, workers.workerId],
    name: "fk_employee_salary_profiles_org_worker",
  }).onDelete("restrict"),
]);

export const employeeSalaryProfileComponents = pgTable("employee_salary_profile_components", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  profileId: integer("profile_id").references(() => employeeSalaryProfiles.id, { onDelete: "cascade" }).notNull(),
  componentId: integer("component_id").references(() => salaryComponents.id, { onDelete: "restrict" }).notNull(),
  calcMethodOverride: salaryComponentCalcMethodEnum("calc_method_override"),
  amount: decimal("amount", { precision: 15, scale: 2 }),
  percent: decimal("percent", { precision: 7, scale: 4 }),
  formulaOverride: text("formula_override"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_employee_salary_profile_components_org_id").on(table.orgId, table.id),
  index("idx_employee_salary_profile_components_profile").on(table.profileId),
  index("idx_employee_salary_profile_components_org").on(table.orgId),
  uniqueIndex("uniq_esp_components_profile_component").on(table.profileId, table.componentId),
]);

export const payrollLoanAdjustments = pgTable("payroll_loan_adjustments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  loanId: integer("loan_id").references(() => salaryLoans.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").references(() => payrollRuns.id, { onDelete: "set null" }),
  type: payrollLoanAdjustmentTypeEnum("type").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }),
  reason: text("reason").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_payroll_loan_adjustments_org_id").on(table.orgId, table.id),
  index("idx_payroll_loan_adjustments_org_loan").on(table.orgId, table.loanId),
  index("idx_payroll_loan_adjustments_run").on(table.runId),
]);

export const salaryComponentsRelations = relations(salaryComponents, ({ one, many }) => ({
  org: one(organizations, { fields: [salaryComponents.orgId], references: [organizations.id] }),
  profileComponents: many(employeeSalaryProfileComponents),
}));

export const employeeSalaryProfilesRelations = relations(employeeSalaryProfiles, ({ one, many }) => ({
  user: one(users, { fields: [employeeSalaryProfiles.userId], references: [users.id] }),
  worker: one(workers, { fields: [employeeSalaryProfiles.workerId], references: [workers.workerId] }),
  createdByUser: one(users, { fields: [employeeSalaryProfiles.createdBy], references: [users.id], relationName: "profileCreatedBy" }),
  components: many(employeeSalaryProfileComponents),
}));

export const employeeSalaryProfileComponentsRelations = relations(employeeSalaryProfileComponents, ({ one }) => ({
  profile: one(employeeSalaryProfiles, { fields: [employeeSalaryProfileComponents.profileId], references: [employeeSalaryProfiles.id] }),
  component: one(salaryComponents, { fields: [employeeSalaryProfileComponents.componentId], references: [salaryComponents.id] }),
}));

export const payrollLoanAdjustmentsRelations = relations(payrollLoanAdjustments, ({ one }) => ({
  loan: one(salaryLoans, { fields: [payrollLoanAdjustments.loanId], references: [salaryLoans.id] }),
  run: one(payrollRuns, { fields: [payrollLoanAdjustments.runId], references: [payrollRuns.id] }),
  createdByUser: one(users, { fields: [payrollLoanAdjustments.createdBy], references: [users.id], relationName: "loanAdjCreatedBy" }),
}));
