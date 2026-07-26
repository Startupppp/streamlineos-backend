import { pgTable, text, timestamp, boolean, jsonb, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { crmAutomationRules } from "./automation-rules";

export const crmAutomationRuns = pgTable("crm_automation_runs", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ruleId: integer("rule_id").references(() => crmAutomationRules.id, { onDelete: "cascade" }).notNull(),
  eventKey: text("event_key").notNull(),
  entityType: text("entity_type").notNull().default(""),
  entityId: text("entity_id").notNull().default(""),
  status: text("status").notNull().default("queued"),
  steps: jsonb("steps").$type<RunStepLog[] | null>(),
  error: text("error"),
  triggeredBy: text("triggered_by").notNull().default("system"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
}, (table) => [
  index("idx_crm_automation_runs_org_rule").on(table.orgId, table.ruleId, table.startedAt),
  unique("uniq_crm_automation_runs_org_id").on(table.orgId, table.id),
]);

export const crmSequences = pgTable("crm_sequences", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  entityType: text("entity_type").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  stopOn: jsonb("stop_on").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_crm_sequences_org_name").on(table.orgId, table.name),
  unique("uniq_crm_sequences_org_id").on(table.orgId, table.id),
]);

export const crmSequenceSteps = pgTable("crm_sequence_steps", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  sequenceId: text("sequence_id").references(() => crmSequences.id, { onDelete: "cascade" }).notNull(),
  sortOrder: integer("sort_order").notNull(),
  stepType: text("step_type").notNull(),
  config: jsonb("config").$type<Record<string, unknown> | null>(),
  waitHours: integer("wait_hours"),
}, (table) => [
  index("idx_crm_sequence_steps_seq_sort").on(table.sequenceId, table.sortOrder),
]);

export const crmSequenceEnrollments = pgTable("crm_sequence_enrollments", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  sequenceId: text("sequence_id").references(() => crmSequences.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  status: text("status").notNull().default("active"),
  currentStep: integer("current_step").notNull().default(0),
  nextRunAt: timestamp("next_run_at"),
  stopReason: text("stop_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_seq_enrollment").on(table.orgId, table.sequenceId, table.entityType, table.entityId),
  index("idx_crm_seq_enrollment_due").on(table.orgId, table.status, table.nextRunAt),
  unique("uniq_crm_seq_enrollments_org_id").on(table.orgId, table.id),
]);

export interface RunStepLog {
  nodeId: string;
  type: string;
  status: "ok" | "skipped" | "error";
  message?: string;
  at: string;
}

export const crmAutomationRunsRelations = relations(crmAutomationRuns, ({ one }) => ({
  organization: one(organizations, { fields: [crmAutomationRuns.orgId], references: [organizations.id] }),
  rule: one(crmAutomationRules, { fields: [crmAutomationRuns.ruleId], references: [crmAutomationRules.id] }),
}));

export const crmSequencesRelations = relations(crmSequences, ({ one, many }) => ({
  organization: one(organizations, { fields: [crmSequences.orgId], references: [organizations.id] }),
  steps: many(crmSequenceSteps),
  enrollments: many(crmSequenceEnrollments),
}));

export const crmSequenceStepsRelations = relations(crmSequenceSteps, ({ one }) => ({
  sequence: one(crmSequences, { fields: [crmSequenceSteps.sequenceId], references: [crmSequences.id] }),
}));

export const crmSequenceEnrollmentsRelations = relations(crmSequenceEnrollments, ({ one }) => ({
  organization: one(organizations, { fields: [crmSequenceEnrollments.orgId], references: [organizations.id] }),
  sequence: one(crmSequences, { fields: [crmSequenceEnrollments.sequenceId], references: [crmSequences.id] }),
}));
