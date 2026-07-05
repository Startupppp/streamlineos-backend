import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  onboardingFlowTypeEnum,
  onboardingFlowSessionStatusEnum,
  onboardingFlowStepStatusEnum,
  onboardingFlowTaskStatusEnum,
  onboardingFlowTaskCategoryEnum,
  moduleSetupChecklistStatusEnum,
  guidedTourProgressStatusEnum,
} from "./enums";
import { organizations, users } from "./auth";
import { departments } from "./hr/employees";

// Server-persisted onboarding progress: org setup wizard, module setup checklists,
// guided tours, and payment setup all share this session/step/task model.
// Deliberately named "onboarding_flow_*" (not "onboarding_*") to avoid colliding
// with the pre-existing HR employee onboarding tables (onboarding_templates,
// onboarding_template_steps, onboarding_tasks, onboarding_steps) which live in
// hr/offboarding.ts and auth.ts and continue to serve that flow unchanged.

export const onboardingFlowSessions = pgTable("onboarding_flow_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type: onboardingFlowTypeEnum("type").notNull(),
  status: onboardingFlowSessionStatusEnum("status").notNull().default("not_started"),
  currentStep: text("current_step"),
  completedSteps: jsonb("completed_steps").$type<string[]>().notNull().default([]),
  skippedSteps: jsonb("skipped_steps").$type<string[]>().notNull().default([]),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  source: text("source"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_onb_flow_sessions_org_user_type").on(table.orgId, table.userId, table.type),
  index("idx_onb_flow_sessions_status").on(table.orgId, table.status),
]);

export const onboardingFlowSteps = pgTable("onboarding_flow_steps", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  sessionId: integer("session_id").references(() => onboardingFlowSessions.id, { onDelete: "cascade" }).notNull(),
  stepKey: text("step_key").notNull(),
  title: text("title"),
  status: onboardingFlowStepStatusEnum("status").notNull().default("todo"),
  required: boolean("required").notNull().default(true),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
  skippedAt: timestamp("skipped_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_onb_flow_steps_session").on(table.sessionId),
  unique("uq_onb_flow_steps_session_key").on(table.sessionId, table.stepKey),
]);

export const onboardingFlowTemplates = pgTable("onboarding_flow_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  type: onboardingFlowTypeEnum("type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  industry: text("industry"),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  jobRole: text("job_role"),
  moduleKey: text("module_key"),
  steps: jsonb("steps").$type<Array<Record<string, unknown>>>().notNull().default([]),
  isSystem: boolean("is_system").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_onb_flow_templates_org_type").on(table.orgId, table.type),
  index("idx_onb_flow_templates_industry").on(table.industry),
]);

export const onboardingFlowTasks = pgTable("onboarding_flow_tasks", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  templateId: integer("template_id").references(() => onboardingFlowTemplates.id, { onDelete: "set null" }),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  title: text("title").notNull(),
  description: text("description"),
  status: onboardingFlowTaskStatusEnum("status").notNull().default("todo"),
  category: onboardingFlowTaskCategoryEnum("category").notNull(),
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("idx_onb_flow_tasks_assignee").on(table.orgId, table.assigneeUserId),
  index("idx_onb_flow_tasks_status").on(table.orgId, table.status),
]);

export const moduleSetupChecklists = pgTable("module_setup_checklists", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  moduleKey: text("module_key").notNull(),
  status: moduleSetupChecklistStatusEnum("status").notNull().default("not_started"),
  progress: integer("progress").notNull().default(0),
  dismissedAt: timestamp("dismissed_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_module_setup_checklists_org_module").on(table.orgId, table.moduleKey),
]);

export const moduleSetupChecklistItems = pgTable("module_setup_checklist_items", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  checklistId: integer("checklist_id").references(() => moduleSetupChecklists.id, { onDelete: "cascade" }).notNull(),
  itemKey: text("item_key").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  actionHref: text("action_href"),
  status: onboardingFlowStepStatusEnum("status").notNull().default("todo"),
  required: boolean("required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  completedAt: timestamp("completed_at"),
  skippedAt: timestamp("skipped_at"),
}, (table) => [
  index("idx_module_checklist_items_checklist").on(table.checklistId),
  unique("uq_module_checklist_items_checklist_key").on(table.checklistId, table.itemKey),
]);

export const guidedTours = pgTable("guided_tours", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  tourKey: text("tour_key").notNull(),
  moduleKey: text("module_key"),
  role: text("role"),
  steps: jsonb("steps").$type<Array<Record<string, unknown>>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_guided_tours_org_key").on(table.orgId, table.tourKey),
]);

export const userTourProgress = pgTable("user_tour_progress", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tourKey: text("tour_key").notNull(),
  status: guidedTourProgressStatusEnum("status").notNull().default("not_started"),
  currentStep: integer("current_step").notNull().default(0),
  completedAt: timestamp("completed_at"),
  dismissedAt: timestamp("dismissed_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_user_tour_progress_org_user_tour").on(table.orgId, table.userId, table.tourKey),
]);

export const onboardingAnalyticsEvents = pgTable("onboarding_analytics_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  source: text("source"),
  stepKey: text("step_key"),
  moduleKey: text("module_key"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_onb_analytics_org_event").on(table.orgId, table.eventType),
  index("idx_onb_analytics_org_created").on(table.orgId, table.createdAt),
]);

export const onboardingFlowSessionsRelations = relations(onboardingFlowSessions, ({ one, many }) => ({
  organization: one(organizations, { fields: [onboardingFlowSessions.orgId], references: [organizations.id] }),
  user: one(users, { fields: [onboardingFlowSessions.userId], references: [users.id] }),
  steps: many(onboardingFlowSteps),
}));

export const onboardingFlowStepsRelations = relations(onboardingFlowSteps, ({ one }) => ({
  session: one(onboardingFlowSessions, { fields: [onboardingFlowSteps.sessionId], references: [onboardingFlowSessions.id] }),
  owner: one(users, { fields: [onboardingFlowSteps.ownerUserId], references: [users.id] }),
}));

export const onboardingFlowTemplatesRelations = relations(onboardingFlowTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [onboardingFlowTemplates.orgId], references: [organizations.id] }),
  department: one(departments, { fields: [onboardingFlowTemplates.departmentId], references: [departments.id] }),
  creator: one(users, { fields: [onboardingFlowTemplates.createdByUserId], references: [users.id] }),
  tasks: many(onboardingFlowTasks),
}));

export const onboardingFlowTasksRelations = relations(onboardingFlowTasks, ({ one }) => ({
  organization: one(organizations, { fields: [onboardingFlowTasks.orgId], references: [organizations.id] }),
  assignee: one(users, { fields: [onboardingFlowTasks.assigneeUserId], references: [users.id], relationName: "onboardingFlowTaskAssignee" }),
  owner: one(users, { fields: [onboardingFlowTasks.ownerUserId], references: [users.id], relationName: "onboardingFlowTaskOwner" }),
  template: one(onboardingFlowTemplates, { fields: [onboardingFlowTasks.templateId], references: [onboardingFlowTemplates.id] }),
}));

export const moduleSetupChecklistsRelations = relations(moduleSetupChecklists, ({ one, many }) => ({
  organization: one(organizations, { fields: [moduleSetupChecklists.orgId], references: [organizations.id] }),
  items: many(moduleSetupChecklistItems),
}));

export const moduleSetupChecklistItemsRelations = relations(moduleSetupChecklistItems, ({ one }) => ({
  checklist: one(moduleSetupChecklists, { fields: [moduleSetupChecklistItems.checklistId], references: [moduleSetupChecklists.id] }),
}));

export const guidedToursRelations = relations(guidedTours, ({ one }) => ({
  organization: one(organizations, { fields: [guidedTours.orgId], references: [organizations.id] }),
}));

export const userTourProgressRelations = relations(userTourProgress, ({ one }) => ({
  organization: one(organizations, { fields: [userTourProgress.orgId], references: [organizations.id] }),
  user: one(users, { fields: [userTourProgress.userId], references: [users.id] }),
}));

export const onboardingAnalyticsEventsRelations = relations(onboardingAnalyticsEvents, ({ one }) => ({
  organization: one(organizations, { fields: [onboardingAnalyticsEvents.orgId], references: [organizations.id] }),
  user: one(users, { fields: [onboardingAnalyticsEvents.userId], references: [users.id] }),
}));
