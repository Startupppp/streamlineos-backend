import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export interface AutomationGraphNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  nextId?: string;
  branches?: { condition: Record<string, unknown>; nextId: string }[];
}

type CrmAutomationTrigger =
  | "lead.created"
  | "lead.status_changed"
  | "lead.score_changed"
  | "lead.assigned"
  | "deal.stage_changed"
  | "task.overdue";

export type CrmAutomationAction =
  | "send_email"
  | "assign_to"
  | "update_field"
  | "create_task"
  | "send_notification"
  | "add_tag";

export interface CrmAutomationCondition {
  field: string;
  operator: "equals" | "contains" | "greater_than" | "less_than" | "is_empty";
  value: string;
}

export const crmAutomationRules = pgTable("crm_automation_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  conditions: jsonb("conditions").$type<CrmAutomationCondition[]>().notNull().default([]),
  actions: jsonb("actions").$type<CrmAutomationAction[]>().notNull().default([]),
  isActive: boolean("is_active").default(true).notNull(),
  executionCount: integer("execution_count").default(0).notNull(),
  lastRunAt: timestamp("last_run_at"),
  graph: jsonb("graph").$type<AutomationGraphNode[] | null>(),
  version: integer("version").default(1).notNull(),
  isDraft: boolean("is_draft").default(false).notNull(),
  lastError: text("last_error"),
  cooldownMinutes: integer("cooldown_minutes").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_crm_automation_rules_org").on(table.orgId, table.isActive, table.createdAt),
  index("idx_crm_automation_rules_deleted").on(table.deletedAt),
  unique("uniq_crm_automation_rules_org_id").on(table.orgId, table.id),
]);

export const crmAutomationRulesRelations = relations(crmAutomationRules, ({ one }) => ({
  organization: one(organizations, { fields: [crmAutomationRules.orgId], references: [organizations.id] }),
}));
