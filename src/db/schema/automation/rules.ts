import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";

export const AUTOMATION_TRIGGERS = [
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
  "ticket.priority_changed",
  "ticket.message_received",
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
  "sign.envelope.sent",
  "sign.envelope.completed",
  "sign.envelope.declined",
  "sign.envelope.voided",
  "sign.envelope.expired",
  "sign.recipient.completed",
  "sign.bulk_send.completed",
] as const;

export type AutomationTriggerEvent = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_RUN_STATUSES = ["success", "failed", "skipped"] as const;

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
  | { type: "webhook"; config: { event: string } }
  | { type: "support_assign_ticket"; config: { assigneeId: string } }
  | { type: "support_set_priority"; config: { priority: string } }
  | { type: "support_add_tag"; config: { tagId: number } }
  | { type: "support_internal_note"; config: { body: string } }
  | { type: "ai_classify"; config: Record<string, unknown> }
  | { type: "ai_summarize"; config: Record<string, unknown> }
  | { type: "ai_extract"; config: Record<string, unknown> }
  | { type: "ai_routing_suggestion"; config: Record<string, unknown> };

export const automationRules = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  triggerEvent: text("trigger_event").notNull(),
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
  unique("uniq_automation_rules_org_id").on(table.orgId, table.id),
]);

export const automationRuns = pgTable("automation_runs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ruleId: integer("rule_id").references(() => automationRules.id, { onDelete: "cascade" }).notNull(),
  triggerEvent: text("trigger_event").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_automation_runs_rule").on(table.ruleId),
  unique("uniq_automation_runs_org_id").on(table.orgId, table.id),
]);

export const automationRulesRelations = relations(automationRules, ({ one, many }) => ({
  organization: one(organizations, { fields: [automationRules.orgId], references: [organizations.id] }),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  organization: one(organizations, { fields: [automationRuns.orgId], references: [organizations.id] }),
  rule: one(automationRules, { fields: [automationRuns.ruleId], references: [automationRules.id] }),
}));
