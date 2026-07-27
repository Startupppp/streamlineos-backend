import { pgTable, pgEnum, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const hrWorkflowObjectTypeEnum = pgEnum("hr_workflow_object_type", [
  "leave_request",
  "attendance_regularization",
  "overtime_request",
  "comp_off_request",
  "expense_reimbursement",
  "travel_request",
  "employee_data_change",
  "document_review",
  "asset_request",
  "onboarding",
  "offboarding",
  "probation_confirmation",
  "promotion",
  "transfer",
  "salary_revision",
  "resignation",
  "termination",
  "grievance_case",
]);

export const hrWorkflowStatusEnum = pgEnum("hr_workflow_status", ["draft", "active", "archived"]);

export const hrWorkflowApproverTypeEnum = pgEnum("hr_workflow_approver_type", [
  "direct_manager",
  "managers_manager",
  "hr_role",
  "finance_role",
  "department_head",
  "location_hr",
  "named_user",
  "dynamic_expression",
]);

export const hrWorkflowStepModeEnum = pgEnum("hr_workflow_step_mode", [
  "serial",
  "parallel_all",
  "parallel_any",
]);

export const hrWorkflowInstanceStatusEnum = pgEnum("hr_workflow_instance_status", [
  "pending",
  "in_progress",
  "approved",
  "rejected",
  "cancelled",
  "reopened",
]);

export const hrWorkflowActionEnum = pgEnum("hr_workflow_action", [
  "approved",
  "rejected",
  "reassigned",
  "escalated",
  "commented",
  "cancelled",
  "reopened",
]);

export const hrWorkflowDefinitions = pgTable("hr_workflow_definitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  objectType: hrWorkflowObjectTypeEnum("object_type").notNull(),
  name: text("name").notNull(),
  status: hrWorkflowStatusEnum("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  settings: jsonb("settings").$type<{
    rejectionCommentRequired?: boolean;
    allowDelegation?: boolean;
    allowReopen?: boolean;
  }>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  unique("uniq_hr_workflow_definitions_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_wf_def_org_type_name_version").on(table.orgId, table.objectType, table.name, table.version),
  index("idx_hr_wf_def_org_type_status").on(table.orgId, table.objectType, table.status),
]);

export const hrWorkflowSteps = pgTable("hr_workflow_steps", {
  id: serial("id").primaryKey(),
  definitionId: integer("definition_id").references(() => hrWorkflowDefinitions.id, { onDelete: "cascade" }).notNull(),
  stepOrder: integer("step_order").notNull(),
  name: text("name").notNull(),
  approverType: hrWorkflowApproverTypeEnum("approver_type").notNull(),
  approverValue: text("approver_value"),
  mode: hrWorkflowStepModeEnum("mode").default("serial").notNull(),
  slaHours: integer("sla_hours"),
  escalationApproverType: hrWorkflowApproverTypeEnum("escalation_approver_type"),
  escalationApproverValue: text("escalation_approver_value"),
  condition: jsonb("condition").$type<{ field: string; operator: string; value: unknown } | null>(),
}, (table) => [
  index("idx_hr_wf_steps_def_order").on(table.definitionId, table.stepOrder),
]);

export const hrWorkflowInstances = pgTable("hr_workflow_instances", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  definitionId: integer("definition_id").references(() => hrWorkflowDefinitions.id, { onDelete: "restrict" }).notNull(),
  definitionSnapshot: jsonb("definition_snapshot").$type<{ steps: unknown[] }>().notNull(),
  objectType: hrWorkflowObjectTypeEnum("object_type").notNull(),
  objectId: text("object_id").notNull(),
  requestedBy: text("requested_by").references(() => users.id, { onDelete: "restrict" }).notNull(),
  subjectEmployeeId: text("subject_employee_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
  status: hrWorkflowInstanceStatusEnum("status").default("pending").notNull(),
  currentStepOrder: integer("current_step_order").default(1).notNull(),
  dueAt: timestamp("due_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_workflow_instances_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_inst_org_obj").on(table.orgId, table.objectType, table.objectId),
  index("idx_hr_wf_inst_org_status").on(table.orgId, table.status),
  index("idx_hr_wf_inst_org_requester").on(table.orgId, table.requestedBy),
]);

export const hrWorkflowStepActions = pgTable("hr_workflow_step_actions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  instanceId: integer("instance_id").references(() => hrWorkflowInstances.id, { onDelete: "cascade" }).notNull(),
  stepOrder: integer("step_order").notNull(),
  approverUserId: text("approver_user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  actedByUserId: text("acted_by_user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  action: hrWorkflowActionEnum("action").notNull(),
  comment: text("comment"),
  attachments: jsonb("attachments").$type<{ url: string; name: string }[]>(),
  actedAt: timestamp("acted_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_workflow_step_actions_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_actions_org_instance").on(table.orgId, table.instanceId),
]);

export const hrWorkflowDelegations = pgTable("hr_workflow_delegations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  delegatorUserId: text("delegator_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  delegateUserId: text("delegate_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  objectType: hrWorkflowObjectTypeEnum("object_type"),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  reason: text("reason"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_workflow_delegations_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_delegations_org_delegator_active").on(table.orgId, table.delegatorUserId, table.active),
]);

export const hrWorkflowDefinitionsRelations = relations(hrWorkflowDefinitions, ({ many }) => ({
  steps: many(hrWorkflowSteps),
  instances: many(hrWorkflowInstances),
}));

export const hrWorkflowStepsRelations = relations(hrWorkflowSteps, ({ one }) => ({
  definition: one(hrWorkflowDefinitions, {
    fields: [hrWorkflowSteps.definitionId],
    references: [hrWorkflowDefinitions.id],
  }),
}));

export const hrWorkflowInstancesRelations = relations(hrWorkflowInstances, ({ one, many }) => ({
  definition: one(hrWorkflowDefinitions, {
    fields: [hrWorkflowInstances.definitionId],
    references: [hrWorkflowDefinitions.id],
  }),
  actions: many(hrWorkflowStepActions),
}));

export const hrWorkflowStepActionsRelations = relations(hrWorkflowStepActions, ({ one }) => ({
  instance: one(hrWorkflowInstances, {
    fields: [hrWorkflowStepActions.instanceId],
    references: [hrWorkflowInstances.id],
  }),
}));
