import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  pgEnum,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrAutomationRunStatusEnum = pgEnum("hr_automation_run_status", [
  "success",
  "partial",
  "failed",
  "skipped",
]);

export const hrAutomationRules = pgTable(
  "hr_automation_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    triggerEvent: text("trigger_event").notNull(),
    conditions: jsonb("conditions").notNull().$type<HrAutomationCondition[]>().default([]),
    actions: jsonb("actions").notNull().$type<HrAutomationAction[]>().default([]),
    isEnabled: boolean("is_enabled").notNull().default(true),
    webhookSecret: text("webhook_secret"),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    unique("uniq_hr_automation_rules_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_automation_rules_org_name").on(table.orgId, table.name),
    index("idx_hr_automation_rules_org_event").on(table.orgId, table.triggerEvent),
    index("idx_hr_automation_rules_org_enabled").on(table.orgId, table.isEnabled),
  ],
);

export const hrAutomationRuns = pgTable(
  "hr_automation_runs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ruleId: integer("rule_id").references(() => hrAutomationRules.id, { onDelete: "cascade" }).notNull(),
    triggerEvent: text("trigger_event").notNull(),
    eventPayload: jsonb("event_payload").$type<Record<string, unknown>>(),
    status: hrAutomationRunStatusEnum("status").notNull(),
    actionResults: jsonb("action_results").$type<HrActionResult[]>(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    triggeredByRunId: integer("triggered_by_run_id").references((): AnyPgColumn => hrAutomationRuns.id, { onDelete: "set null" }),
    depth: integer("depth").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_automation_runs_org_id").on(table.orgId, table.id),
    index("idx_hr_automation_runs_org_rule_created").on(table.orgId, table.ruleId, table.createdAt),
    index("idx_hr_automation_runs_org_status").on(table.orgId, table.status),
  ],
);

export const hrAutomationRulesRelations = relations(hrAutomationRules, ({ many }) => ({
  runs: many(hrAutomationRuns),
}));

export const hrAutomationRunsRelations = relations(hrAutomationRuns, ({ one }) => ({
  rule: one(hrAutomationRules, {
    fields: [hrAutomationRuns.ruleId],
    references: [hrAutomationRules.id],
  }),
}));

export interface HrAutomationCondition {
  field: string;
  operator: "eq" | "neq" | "in" | "gte" | "lte" | "contains";
  value: string | number | boolean | string[];
}

export type HrAutomationAction =
  | { type: "create_task"; config: { title: string; assigneeId?: string; dueInDays?: number } }
  | { type: "start_workflow"; config: { workflowId: string } }
  | { type: "send_notification"; config: { title: string; message: string; link?: string; roles?: string[] } }
  | { type: "send_email"; config: { to: string; subject: string; body: string } }
  | { type: "assign_document"; config: { documentTypeId: number } }
  | { type: "generate_letter"; config: { templateId: number } }
  | { type: "assign_course"; config: { courseId: number } }
  | { type: "assign_asset"; config: { assetTypeId: number } }
  | { type: "create_hr_case"; config: { subject: string; categoryId?: number } }
  | { type: "update_field"; config: { field: string; value: string | number | boolean } }
  | { type: "call_webhook"; config: { url: string; method?: "POST" | "PUT" } };

export interface HrActionResult {
  type: string;
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}
