import { boolean, date, decimal, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { ledgerAccounts } from "./accounting";
import { departments } from "../hr/employees";
import { projects } from "../build";

export const finBudgetPeriodEnum = pgEnum("fin_budget_period", ["MONTHLY", "QUARTERLY", "YEARLY"]);
export const finBudgetDimensionEnum = pgEnum("fin_budget_dimension", ["NONE", "DEPARTMENT", "PROJECT"]);
export const finBudgetStatusEnum = pgEnum("fin_budget_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ARCHIVED"]);
export const finScenarioKindEnum = pgEnum("fin_scenario_kind", ["CONSERVATIVE", "EXPECTED", "AGGRESSIVE", "CUSTOM"]);

export const finBudgets = pgTable("fin_budgets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  fiscalYear: text("fiscal_year").notNull(),
  periodType: finBudgetPeriodEnum("period_type").default("MONTHLY").notNull(),
  dimensionType: finBudgetDimensionEnum("dimension_type").default("NONE"),
  status: finBudgetStatusEnum("status").default("DRAFT").notNull(),
  totalAmount: decimal("total_amount", { precision: 18, scale: 4 }).default("0").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_budgets_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_budgets_org_name_year").on(table.orgId, table.name, table.fiscalYear),
  index("idx_fin_budgets_org_status").on(table.orgId, table.status),
]);

export const finBudgetLines = pgTable("fin_budget_lines", {
  id: serial("id").primaryKey(),
  budgetId: integer("budget_id").references(() => finBudgets.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  accountId: integer("account_id").references(() => ledgerAccounts.id).notNull(),
  departmentId: integer("department_id").references(() => departments.id),
  projectId: integer("project_id").references(() => projects.id),
  periodKey: text("period_key").notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_budget_lines_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_fin_budget_lines_budget_acct_period").on(table.budgetId, table.accountId, table.periodKey, table.departmentId, table.projectId),
  index("idx_fin_budget_lines_org_budget").on(table.orgId, table.budgetId),
]);

export const finBudgetRevisions = pgTable("fin_budget_revisions", {
  id: serial("id").primaryKey(),
  budgetId: integer("budget_id").references(() => finBudgets.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  revisionNumber: integer("revision_number").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_fin_budget_revisions_org_id").on(table.orgId, table.id),
  index("idx_fin_budget_revisions_budget").on(table.budgetId),
]);

export const finCashFlowScenarios = pgTable("fin_cash_flow_scenarios", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  kind: finScenarioKindEnum("kind").default("EXPECTED").notNull(),
  assumptions: jsonb("assumptions"),
  isDefault: boolean("is_default").default(false).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_fin_cash_flow_scenarios_org_id").on(table.orgId, table.id),
  index("idx_fin_cash_flow_scenarios_org").on(table.orgId),
]);

export const finBudgetsRelations = relations(finBudgets, ({ one, many }) => ({
  organization: one(organizations, { fields: [finBudgets.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [finBudgets.createdBy], references: [users.id], relationName: "budgetCreatedBy" }),
  approver: one(users, { fields: [finBudgets.approvedBy], references: [users.id], relationName: "budgetApprovedBy" }),
  lines: many(finBudgetLines),
  revisions: many(finBudgetRevisions),
}));

export const finBudgetLinesRelations = relations(finBudgetLines, ({ one }) => ({
  budget: one(finBudgets, { fields: [finBudgetLines.budgetId], references: [finBudgets.id] }),
  organization: one(organizations, { fields: [finBudgetLines.orgId], references: [organizations.id] }),
  account: one(ledgerAccounts, { fields: [finBudgetLines.accountId], references: [ledgerAccounts.id] }),
  department: one(departments, { fields: [finBudgetLines.departmentId], references: [departments.id] }),
  project: one(projects, { fields: [finBudgetLines.projectId], references: [projects.id] }),
}));

export const finBudgetRevisionsRelations = relations(finBudgetRevisions, ({ one }) => ({
  budget: one(finBudgets, { fields: [finBudgetRevisions.budgetId], references: [finBudgets.id] }),
  organization: one(organizations, { fields: [finBudgetRevisions.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [finBudgetRevisions.createdBy], references: [users.id] }),
}));

export const finCashFlowScenariosRelations = relations(finCashFlowScenarios, ({ one }) => ({
  organization: one(organizations, { fields: [finCashFlowScenarios.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [finCashFlowScenarios.createdBy], references: [users.id] }),
}));

export type FinBudget = typeof finBudgets.$inferSelect;
export type NewFinBudget = typeof finBudgets.$inferInsert;
export type FinBudgetLine = typeof finBudgetLines.$inferSelect;
export type FinBudgetRevision = typeof finBudgetRevisions.$inferSelect;
export type FinCashFlowScenario = typeof finCashFlowScenarios.$inferSelect;
