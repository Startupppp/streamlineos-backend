import { pgTable, pgEnum, text, uuid, timestamp, jsonb, integer, index, boolean, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "./auth";

export const workflowStatusEnum = pgEnum("workflow_status", ["draft", "published", "disabled", "archived"]);
export const workflowExecutionStatusEnum = pgEnum("workflow_execution_status", ["pending", "running", "waiting", "completed", "failed", "cancelled", "timed_out"]);
export const workflowTriggerTypeEnum = pgEnum("workflow_trigger_type", ["event", "schedule", "webhook", "api", "manual"]);
export const workflowApprovalStatusEnum = pgEnum("workflow_approval_status", ["pending", "approved", "rejected", "delegated", "expired"]);
export const workflowNodeTypeEnum = pgEnum("workflow_node_type", ["trigger", "condition", "approval", "action", "delay", "loop", "ai_action", "integration", "script", "end"]);

export const workflows = pgTable("workflows", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatusEnum("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_workflows_org").on(table.orgId),
  index("idx_workflows_org_status").on(table.orgId, table.status),
  unique("uniq_workflows_org_id").on(table.orgId, table.id),
]);

export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  definitionJson: jsonb("definition_json").$type<Record<string, unknown>>().notNull(),
  publishedBy: text("published_by"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_versions_workflow").on(table.workflowId),
  index("idx_workflow_versions_workflow_version").on(table.workflowId, table.version),
]);

export const workflowExecutions = pgTable("workflow_executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }).notNull(),
  workflowVersionId: uuid("workflow_version_id").references(() => workflowVersions.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  status: workflowExecutionStatusEnum("status").default("pending").notNull(),
  triggerType: workflowTriggerTypeEnum("trigger_type"),
  triggerData: jsonb("trigger_data").$type<Record<string, unknown>>(),
  context: jsonb("context").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  durationMs: integer("duration_ms"),
  triggeredBy: text("triggered_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_executions_org").on(table.orgId),
  index("idx_workflow_executions_org_status").on(table.orgId, table.status),
  index("idx_workflow_executions_workflow").on(table.workflowId),
  index("idx_workflow_executions_org_created").on(table.orgId, table.createdAt),
  unique("uniq_workflow_executions_org_id").on(table.orgId, table.id),
]);

export const workflowExecutionSteps = pgTable("workflow_execution_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  executionId: uuid("execution_id").references(() => workflowExecutions.id, { onDelete: "cascade" }).notNull(),
  nodeId: text("node_id").notNull(),
  nodeType: workflowNodeTypeEnum("node_type").notNull(),
  status: workflowExecutionStatusEnum("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_execution_steps_execution").on(table.executionId),
  index("idx_workflow_execution_steps_execution_node").on(table.executionId, table.nodeId),
]);

export const workflowApprovals = pgTable("workflow_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  executionId: uuid("execution_id").references(() => workflowExecutions.id, { onDelete: "cascade" }).notNull(),
  stepId: uuid("step_id").references(() => workflowExecutionSteps.id, { onDelete: "cascade" }).notNull(),
  approverId: text("approver_id").notNull(),
  status: workflowApprovalStatusEnum("status").default("pending").notNull(),
  comment: text("comment"),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_approvals_execution").on(table.executionId),
  index("idx_workflow_approvals_approver_status").on(table.approverId, table.status),
]);

export const workflowSchedules = pgTable("workflow_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  cronExpression: text("cron_expression").notNull(),
  timezone: text("timezone").default("UTC").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_workflow_schedules_workflow").on(table.workflowId),
  index("idx_workflow_schedules_org_enabled").on(table.orgId, table.isEnabled),
  index("idx_workflow_schedules_next_run").on(table.nextRunAt),
  unique("uniq_workflow_schedules_org_id").on(table.orgId, table.id),
]);

export const workflowVariables = pgTable("workflow_variables", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowVersionId: uuid("workflow_version_id").references(() => workflowVersions.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  valueType: text("value_type").notNull(),
  defaultValue: jsonb("default_value").$type<unknown>(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_variables_version").on(table.workflowVersionId),
]);

export const workflowSecrets = pgTable("workflow_secrets", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_workflow_secrets_org").on(table.orgId),
  unique("uniq_workflow_secrets_org_id").on(table.orgId, table.id),
]);

export const workflowAuditLogs = pgTable("workflow_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
  executionId: uuid("execution_id").references(() => workflowExecutions.id, { onDelete: "cascade" }),
  actorId: text("actor_id"),
  event: text("event").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_workflow_audit_logs_org").on(table.orgId),
  index("idx_workflow_audit_logs_workflow").on(table.workflowId),
  index("idx_workflow_audit_logs_org_created").on(table.orgId, table.createdAt),
  unique("uniq_workflow_audit_logs_org_id").on(table.orgId, table.id),
]);

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  organization: one(organizations, { fields: [workflows.orgId], references: [organizations.id] }),
  versions: many(workflowVersions),
  executions: many(workflowExecutions),
  schedules: many(workflowSchedules),
  auditLogs: many(workflowAuditLogs),
}));

export const workflowVersionsRelations = relations(workflowVersions, ({ one, many }) => ({
  workflow: one(workflows, { fields: [workflowVersions.workflowId], references: [workflows.id] }),
  variables: many(workflowVariables),
  executions: many(workflowExecutions),
}));

export const workflowExecutionsRelations = relations(workflowExecutions, ({ one, many }) => ({
  workflow: one(workflows, { fields: [workflowExecutions.workflowId], references: [workflows.id] }),
  version: one(workflowVersions, { fields: [workflowExecutions.workflowVersionId], references: [workflowVersions.id] }),
  organization: one(organizations, { fields: [workflowExecutions.orgId], references: [organizations.id] }),
  steps: many(workflowExecutionSteps),
  approvals: many(workflowApprovals),
  auditLogs: many(workflowAuditLogs),
}));

export const workflowExecutionStepsRelations = relations(workflowExecutionSteps, ({ one, many }) => ({
  execution: one(workflowExecutions, { fields: [workflowExecutionSteps.executionId], references: [workflowExecutions.id] }),
  approvals: many(workflowApprovals),
}));

export const workflowApprovalsRelations = relations(workflowApprovals, ({ one }) => ({
  execution: one(workflowExecutions, { fields: [workflowApprovals.executionId], references: [workflowExecutions.id] }),
  step: one(workflowExecutionSteps, { fields: [workflowApprovals.stepId], references: [workflowExecutionSteps.id] }),
}));

export const workflowSchedulesRelations = relations(workflowSchedules, ({ one }) => ({
  workflow: one(workflows, { fields: [workflowSchedules.workflowId], references: [workflows.id] }),
  organization: one(organizations, { fields: [workflowSchedules.orgId], references: [organizations.id] }),
}));

export const workflowVariablesRelations = relations(workflowVariables, ({ one }) => ({
  version: one(workflowVersions, { fields: [workflowVariables.workflowVersionId], references: [workflowVersions.id] }),
}));

export const workflowSecretsRelations = relations(workflowSecrets, ({ one }) => ({
  organization: one(organizations, { fields: [workflowSecrets.orgId], references: [organizations.id] }),
}));

export const workflowAuditLogsRelations = relations(workflowAuditLogs, ({ one }) => ({
  organization: one(organizations, { fields: [workflowAuditLogs.orgId], references: [organizations.id] }),
  workflow: one(workflows, { fields: [workflowAuditLogs.workflowId], references: [workflows.id] }),
  execution: one(workflowExecutions, { fields: [workflowAuditLogs.executionId], references: [workflowExecutions.id] }),
}));
