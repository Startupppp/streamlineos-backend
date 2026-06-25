import { pgTable, pgEnum, text, serial, timestamp, boolean, jsonb, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export const automationTriggerEnum = pgEnum("automation_trigger", [
  "lead.created",
  "lead.status_changed",
  "lead.assigned",
  "lead.score_updated",
  "deal.created",
  "deal.stage_changed",
  "deal.won",
  "deal.lost",
  "ticket.created",
  "ticket.assigned",
  "ticket.status_changed",
  "ticket.escalated",
  "invoice.overdue",
  "invoice.paid",
  "candidate.application_created",
  "candidate.stage_changed",
  "candidate.bgv_status_changed",
  "interview.scheduled",
  "interview.completed",
  "scorecard.submitted",
  "offer.sent",
  "offer.accepted",
  "offer.rejected",
  "sla.breached",
  "onboarding.started",
  "onboarding.task_overdue",
  "onboarding.document_submitted",
  "onboarding.completed",
  "leave.requested",
  "leave.approved",
  "leave.rejected",
  "attendance.anomaly",
  "attendance.late",
  "resignation.submitted",
  "resignation.approved",
  "employee.onboarded",
  "employee.terminated",
  "employee.resignation",
  "certification.expiring",
  "document.review_requested",
  "performance.review_cycle_started",
  "review.cycle_started",
  "expense.submitted",
  "expense.approved",
  "reimbursement.approved",
  "reimbursement.rejected",
]);

export const automationRunStatusEnum = pgEnum("automation_run_status", [
  "success",
  "failed",
  "skipped",
]);

export interface AutomationCondition {
  field: string;
  op: "eq" | "neq" | "contains" | "gt" | "lt" | "exists";
  value?: string | number | boolean;
}

export type AutomationAction =
  | { type: "notify_roles"; config: { roles: string[]; title: string; message: string; link?: string } }
  | { type: "notify_all"; config: { title: string; message: string; link?: string } }
  | { type: "email"; config: { to: string; subject: string; body: string } }
  | { type: "create_task"; config: { title: string; assigneeId?: string; dueInDays?: number } }
  | { type: "webhook"; config: { event: string } };

export const automationRules = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  triggerEvent: automationTriggerEnum("trigger_event").notNull(),
  conditions: jsonb("conditions").$type<AutomationCondition[]>().default([]).notNull(),
  actions: jsonb("actions").$type<AutomationAction[]>().default([]).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  runCount: integer("run_count").default(0).notNull(),
  lastRunAt: timestamp("last_run_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_automation_rules_org_trigger_enabled").on(table.orgId, table.triggerEvent, table.isEnabled),
]);

export const automationRuns = pgTable("automation_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ruleId: integer("rule_id").references(() => automationRules.id, { onDelete: "cascade" }).notNull(),
  triggerEvent: text("trigger_event").notNull(),
  status: automationRunStatusEnum("status").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_automation_runs_rule").on(table.ruleId),
]);

export const automationRulesRelations = relations(automationRules, ({ one, many }) => ({
  organization: one(organizations, { fields: [automationRules.orgId], references: [organizations.id] }),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  organization: one(organizations, { fields: [automationRuns.orgId], references: [organizations.id] }),
  rule: one(automationRules, { fields: [automationRuns.ruleId], references: [automationRules.id] }),
}));
