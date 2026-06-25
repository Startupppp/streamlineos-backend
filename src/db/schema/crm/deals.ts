import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, foreignKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  dealStageEnum, dealActivityTypeEnum, slaAppliesToEnum, slaPriorityEnum,
  incentiveStatusEnum, taskEntityTypeEnum, taskTypeEnum, taskStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { payrolls } from "../hr";
import { leads } from "./leads";
import { clients, branches, clientAccounts, contacts, crmOrganizations } from "./contacts";

export const deals = pgTable("deals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  value: decimal("value", { precision: 15, scale: 2 }).default("0").notNull(),
  stage: dealStageEnum("stage").default("LEAD").notNull(),
  probability: integer("probability").default(0).notNull(),
  contactPerson: text("contact_person"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  assignedToId: text("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
  lastContactDate: timestamp("last_contact_date"),
  expectedCloseDate: date("expected_close_date"),
  actualCloseDate: date("actual_close_date"),
  lostReason: text("lost_reason"),
  notes: text("notes"),
  slaDeadline: timestamp("sla_deadline"),
  followUpDate: timestamp("follow_up_date"),
  followUpNotes: text("follow_up_notes"),
  customData: jsonb("custom_data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_deals_org_stage_assignee").on(table.orgId, table.stage, table.assignedToId),
  index("idx_deals_client").on(table.clientId),
  index("idx_deals_lead").on(table.leadId),
  index("idx_deals_close_date").on(table.expectedCloseDate),
]);

export const dealActivities = pgTable("deal_activities", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "cascade" }).notNull(),
  type: dealActivityTypeEnum("type").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  subject: text("subject"),
  notes: text("notes"),
  duration: integer("duration"),
  userId: text("user_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_deal_activities_deal").on(table.dealId),
  index("idx_deal_activities_org").on(table.orgId),
]);

export const dealMeetings = pgTable("deal_meetings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  durationMinutes: integer("duration_minutes").default(30).notNull(),
  attendees: text("attendees").array(),
  agenda: text("agenda"),
  notes: text("notes"),
  actionItems: text("action_items"),
  recordingLink: text("recording_link"),
  status: text("status").default("scheduled").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_deal_meetings_deal").on(table.dealId),
  index("idx_deal_meetings_org").on(table.orgId),
]);

export const dealApprovalRules = pgTable("deal_approval_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  minValue: decimal("min_value", { precision: 15, scale: 2 }).default("0").notNull(),
  approverRole: text("approver_role").default("CEO").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const dealApprovals = pgTable("deal_approvals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  dealId: integer("deal_id").references(() => deals.id).notNull(),
  requestedBy: text("requested_by").references(() => users.id).notNull(),
  requestedStage: text("requested_stage").notNull(),
  status: text("status").default("pending").notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("idx_deal_approvals_org").on(table.orgId, table.status),
  index("idx_deal_approvals_deal").on(table.dealId),
]);

export const salesQuotas = pgTable("sales_quotas", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  period: text("period").default("monthly").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  targetRevenue: decimal("target_revenue", { precision: 15, scale: 2 }).default("0").notNull(),
  actualRevenue: decimal("actual_revenue", { precision: 15, scale: 2 }).default("0").notNull(),
  notes: text("notes"),
  setById: text("set_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_sales_quotas_org_user").on(table.orgId, table.userId),
]);

export const commissionRules = pgTable("commission_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").default("flat_percent").notNull(),
  flatRate: decimal("flat_rate", { precision: 5, scale: 2 }),
  tiers: jsonb("tiers").$type<Array<{ minValue: number; maxValue?: number | null; rate: number }>>(),
  appliesTo: text("applies_to").default("all").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const commissions = pgTable("commissions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "cascade" }).notNull(),
  ruleId: integer("rule_id").references(() => commissionRules.id, { onDelete: "set null" }),
  dealValue: decimal("deal_value", { precision: 15, scale: 2 }).default("0").notNull(),
  commissionRate: decimal("commission_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  commissionAmount: decimal("commission_amount", { precision: 15, scale: 2 }).default("0").notNull(),
  status: text("status").default("pending").notNull(),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_commissions_org_user").on(table.orgId, table.userId),
  index("idx_commissions_deal").on(table.dealId),
]);

export const targets = pgTable("targets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  metricType: text("metric_type").notNull(),
  targetValue: decimal("target_value", { precision: 15, scale: 2 }).notNull(),
  currentValue: decimal("current_value", { precision: 15, scale: 2 }).default("0").notNull(),
  period: text("period").default("daily").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  setById: text("set_by_id").references(() => users.id, { onDelete: "set null" }),
  branchId: integer("branch_id").references(() => branches.id, { onDelete: "set null" }),
  parentTargetId: integer("parent_target_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.parentTargetId], foreignColumns: [table.id] }).onDelete("set null"),
  index("idx_targets_user_period").on(table.userId, table.period),
  index("idx_targets_branch").on(table.branchId),
  index("idx_targets_parent").on(table.parentTargetId),
]);

export const targetHistory = pgTable("target_history", {
  id: serial("id").primaryKey(),
  targetId: integer("target_id").references(() => targets.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  changedById: text("changed_by_id").references(() => users.id).notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_target_history_target").on(table.targetId),
  index("idx_target_history_org_created").on(table.orgId, table.createdAt),
]);

export const incentiveConfig = pgTable("incentive_config", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  branchId: integer("branch_id").references(() => branches.id),
  incentiveRate: decimal("incentive_rate", { precision: 5, scale: 2 }).notNull(),
  effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
  effectiveTo: timestamp("effective_to"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const incentives = pgTable("incentives", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  branchId: integer("branch_id").references(() => branches.id),
  clientAccountId: integer("client_account_id").notNull().references(() => clientAccounts.id),
  salesRepId: text("sales_rep_id").notNull().references(() => users.id),
  investmentAmount: decimal("investment_amount", { precision: 15, scale: 2 }).notNull(),
  incentiveRate: decimal("incentive_rate", { precision: 5, scale: 2 }).notNull(),
  calculatedAmount: decimal("calculated_amount", { precision: 15, scale: 2 }).notNull(),
  approvedAmount: decimal("approved_amount", { precision: 15, scale: 2 }),
  status: incentiveStatusEnum("status").notNull().default("PENDING"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  payrollId: integer("payroll_id").references(() => payrolls.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_incentives_org").on(table.orgId),
  index("idx_incentives_sales_rep").on(table.salesRepId),
  index("idx_incentives_status").on(table.status),
]);

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  entityType: taskEntityTypeEnum("entity_type"),
  entityId: integer("entity_id"),
  type: taskTypeEnum("type").notNull().default("CUSTOM"),
  status: taskStatusEnum("status").notNull().default("pending"),
  assigneeId: text("assignee_id").references(() => users.id),
  createdBy: text("created_by").references(() => users.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  remindAt: timestamp("remind_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  timezone: text("timezone"),
  recurrence: jsonb("recurrence").$type<{
    frequency: "DAILY" | "WEEKLY" | "MONTHLY";
    interval: number;
    endDate?: string;
  } | null>(),
  parentTaskId: integer("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
  isTemplate: boolean("is_template").notNull().default(false),
  templateName: text("template_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_tasks_org").on(table.orgId),
  index("idx_tasks_assignee").on(table.assigneeId),
  index("idx_tasks_status").on(table.status),
  index("idx_tasks_due_date").on(table.dueDate),
  index("idx_tasks_entity").on(table.entityType, table.entityId),
  index("idx_tasks_parent").on(table.parentTaskId),
]);

export const taskSequences = pgTable("task_sequences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const taskSequenceSteps = pgTable("task_sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").notNull().references(() => taskSequences.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type").notNull().default("CUSTOM"),
  notes: text("notes"),
  offsetDays: integer("offset_days").notNull().default(0),
  order: integer("order").notNull().default(0),
});

export const territories = pgTable("territories", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  states: text("states").array().default([]),
  cities: text("cities").array().default([]),
  assignedReps: integer("assigned_reps").array().default([]),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("territories_org_id_idx").on(table.orgId),
]);

export const customFieldDefinitions = pgTable("custom_field_definitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  name: text("name").notNull(),
  label: text("label").notNull(),
  fieldType: text("field_type").notNull().default("text"),
  options: jsonb("options").$type<Array<{ value: string; label: string }>>(),
  isRequired: boolean("is_required").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("cfd_org_entity_name_idx").on(table.orgId, table.entityType, table.name),
  index("idx_cfd_org_entity").on(table.orgId, table.entityType),
]);

export const contactsRelations = relations(contacts, ({ one }) => ({
  organization: one(organizations, { fields: [contacts.orgId], references: [organizations.id] }),
  crmOrganization: one(crmOrganizations, { fields: [contacts.organizationId], references: [crmOrganizations.id] }),
  lead: one(leads, { fields: [contacts.leadId], references: [leads.id] }),
  deal: one(deals, { fields: [contacts.dealId], references: [deals.id] }),
}));

export const dealsRelations = relations(deals, ({ one, many }) => ({
  organization: one(organizations, { fields: [deals.orgId], references: [organizations.id] }),
  lead: one(leads, { fields: [deals.leadId], references: [leads.id] }),
  client: one(clients, { fields: [deals.clientId], references: [clients.id] }),
  assignedTo: one(users, { fields: [deals.assignedToId], references: [users.id] }),
  activities: many(dealActivities),
  meetings: many(dealMeetings),
}));

export const dealMeetingsRelations = relations(dealMeetings, ({ one }) => ({
  deal: one(deals, { fields: [dealMeetings.dealId], references: [deals.id] }),
  creator: one(users, { fields: [dealMeetings.createdBy], references: [users.id] }),
}));

export const dealActivitiesRelations = relations(dealActivities, ({ one }) => ({
  deal: one(deals, { fields: [dealActivities.dealId], references: [deals.id] }),
  user: one(users, { fields: [dealActivities.userId], references: [users.id] }),
}));

export const targetsRelations = relations(targets, ({ one, many }) => ({
  user: one(users, { fields: [targets.userId], references: [users.id] }),
  setBy: one(users, { fields: [targets.setById], references: [users.id], relationName: "targetSetter" }),
  history: many(targetHistory),
}));

export const targetHistoryRelations = relations(targetHistory, ({ one }) => ({
  target: one(targets, { fields: [targetHistory.targetId], references: [targets.id] }),
  changedBy: one(users, { fields: [targetHistory.changedById], references: [users.id] }),
}));

export const incentivesRelations = relations(incentives, ({ one }) => ({
  organization: one(organizations, { fields: [incentives.orgId], references: [organizations.id] }),
  clientAccount: one(clientAccounts, { fields: [incentives.clientAccountId], references: [clientAccounts.id] }),
  salesRep: one(users, { fields: [incentives.salesRepId], references: [users.id] }),
  approver: one(users, { fields: [incentives.approvedBy], references: [users.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  organization: one(organizations, { fields: [tasks.orgId], references: [organizations.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id], relationName: "taskAssignee" }),
  createdByUser: one(users, { fields: [tasks.createdBy], references: [users.id], relationName: "taskCreator" }),
  parentTask: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: "childTasks" }),
}));

export const taskSequencesRelations = relations(taskSequences, ({ one, many }) => ({
  organization: one(organizations, { fields: [taskSequences.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [taskSequences.createdBy], references: [users.id] }),
  steps: many(taskSequenceSteps),
}));

export const taskSequenceStepsRelations = relations(taskSequenceSteps, ({ one }) => ({
  sequence: one(taskSequences, { fields: [taskSequenceSteps.sequenceId], references: [taskSequences.id] }),
}));

export const territoriesRelations = relations(territories, ({ one }) => ({
  organization: one(organizations, { fields: [territories.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [territories.createdBy], references: [users.id] }),
}));

export const customFieldDefinitionsRelations = relations(customFieldDefinitions, ({ one }) => ({
  organization: one(organizations, { fields: [customFieldDefinitions.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [customFieldDefinitions.createdBy], references: [users.id] }),
}));
