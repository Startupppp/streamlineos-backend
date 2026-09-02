import { pgTable, pgEnum, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../common/auth";

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
  definitionId: integer("definition_id").notNull(),
  definitionSnapshot: jsonb("definition_snapshot").$type<{ steps: unknown[] }>().notNull(),
  objectType: hrWorkflowObjectTypeEnum("object_type").notNull(),
  objectId: text("object_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  requestedByMembershipId: integer("requested_by_membership_id"),
  subjectEmployeeId: text("subject_employee_id").notNull(),
  subjectEmployeeMembershipId: integer("subject_employee_membership_id"),
  context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
  status: hrWorkflowInstanceStatusEnum("status").default("pending").notNull(),
  currentStepOrder: integer("current_step_order").default(1).notNull(),
  dueAt: timestamp("due_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.definitionId], foreignColumns: [hrWorkflowDefinitions.orgId, hrWorkflowDefinitions.id], name: "fk_hr_workflow_instances_definition_id_org" }),
  unique("uniq_hr_workflow_instances_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_inst_org_obj").on(table.orgId, table.objectType, table.objectId),
  index("idx_hr_wf_inst_org_status").on(table.orgId, table.status),
  index("idx_hr_wf_inst_org_requester").on(table.orgId, table.requestedBy),
  index("idx_hr_wf_inst_org_requester_membership").on(table.orgId, table.requestedByMembershipId),
  index("idx_hr_wf_inst_org_subject_membership").on(table.orgId, table.subjectEmployeeMembershipId),
  foreignKey({ columns: [table.orgId, table.requestedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_instances_requested_by_actor" }).onDelete("restrict"),
  foreignKey({ columns: [table.orgId, table.subjectEmployeeMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_instances_subject_actor" }).onDelete("restrict"),
]);

export const hrWorkflowStepActions = pgTable("hr_workflow_step_actions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  instanceId: integer("instance_id").notNull(),
  stepOrder: integer("step_order").notNull(),
  approverUserId: text("approver_user_id").notNull(),
  approverMembershipId: integer("approver_membership_id"),
  actedByUserId: text("acted_by_user_id").notNull(),
  actedByMembershipId: integer("acted_by_membership_id"),
  action: hrWorkflowActionEnum("action").notNull(),
  comment: text("comment"),
  actedAt: timestamp("acted_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.instanceId], foreignColumns: [hrWorkflowInstances.orgId, hrWorkflowInstances.id], name: "fk_hr_workflow_step_actions_org_instance" }).onDelete("cascade"),
  unique("uniq_hr_workflow_step_actions_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_actions_org_instance").on(table.orgId, table.instanceId),
  index("idx_hr_wf_actions_org_approver_membership").on(table.orgId, table.approverMembershipId),
  foreignKey({ columns: [table.orgId, table.approverMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_step_actions_approver_actor" }).onDelete("restrict"),
  foreignKey({ columns: [table.orgId, table.actedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_step_actions_acted_by_actor" }).onDelete("restrict"),
]);

export const hrWorkflowInstanceAttachments = pgTable("hr_workflow_instance_attachments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actionId: integer("action_id").notNull(),
  url: text("url").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_hr_wf_inst_attachments_action").on(table.actionId),
  foreignKey({
    columns: [table.orgId, table.actionId],
    foreignColumns: [hrWorkflowStepActions.orgId, hrWorkflowStepActions.id],
  }).onDelete("cascade"),
  unique("uniq_hr_wf_inst_attachments_org_id").on(table.orgId, table.id),
]);

export const hrWorkflowDelegations = pgTable("hr_workflow_delegations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  delegatorUserId: text("delegator_user_id").notNull(),
  delegatorMembershipId: integer("delegator_membership_id"),
  delegateUserId: text("delegate_user_id").notNull(),
  delegateMembershipId: integer("delegate_membership_id"),
  objectType: hrWorkflowObjectTypeEnum("object_type"),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  reason: text("reason"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_workflow_delegations_org_id").on(table.orgId, table.id),
  index("idx_hr_wf_delegations_org_delegator_active").on(table.orgId, table.delegatorUserId, table.active),
  foreignKey({ columns: [table.orgId, table.delegatorMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_delegations_delegator_actor" }).onDelete("restrict"),
  foreignKey({ columns: [table.orgId, table.delegateMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_hr_workflow_delegations_delegate_actor" }).onDelete("restrict"),
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

export const hrWorkflowStepActionsRelations = relations(hrWorkflowStepActions, ({ one, many }) => ({
  instance: one(hrWorkflowInstances, {
    fields: [hrWorkflowStepActions.instanceId],
    references: [hrWorkflowInstances.id],
  }),
  attachments: many(hrWorkflowInstanceAttachments),
}));

export const hrWorkflowInstanceAttachmentsRelations = relations(
  hrWorkflowInstanceAttachments,
  ({ one }) => ({
    action: one(hrWorkflowStepActions, {
      fields: [hrWorkflowInstanceAttachments.orgId, hrWorkflowInstanceAttachments.actionId],
      references: [hrWorkflowStepActions.orgId, hrWorkflowStepActions.id],
    }),
  }),
);
