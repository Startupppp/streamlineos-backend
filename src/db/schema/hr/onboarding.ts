import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { onboardingDocumentStatusEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { documentTypes } from "./document-catalog";

type OnboardingTaskOwnerRole = "NEW_HIRE" | "HR" | "MANAGER" | "IT";
type OnboardingTaskStatus = "PENDING" | "COMPLETED";

export const onboardingTemplates = pgTable("onboarding_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  departmentId: text("department_id"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.departmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_onboarding_templates_department_id_org" }).onDelete("set null"),
  unique("uniq_onboarding_templates_org_id").on(table.orgId, table.id),
]);

export const onboardingTemplateSteps = pgTable("onboarding_template_steps", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  templateId: integer("template_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  ownerRole: text("owner_role").$type<OnboardingTaskOwnerRole>().notNull().default("NEW_HIRE"),
  dueOffsetDays: integer("due_offset_days").notNull().default(0),
  isRequired: boolean("is_required").notNull().default(true),
  isComplianceItem: boolean("is_compliance_item").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [onboardingTemplates.orgId, onboardingTemplates.id], name: "fk_onboarding_template_steps_template_id_org" }).onDelete("cascade"),
  unique("uniq_onboarding_template_steps_org_id").on(table.orgId, table.id),
  check(
    "chk_onboarding_template_steps_owner_role",
    sql`${table.ownerRole} IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')`,
  ),
]);

export const onboardingTasks = pgTable("onboarding_tasks", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  orgId: text("org_id").notNull().references(() => organizations.id),
  templateStepId: integer("template_step_id"),
  title: text("title").notNull(),
  description: text("description"),
  ownerRole: text("owner_role").$type<OnboardingTaskOwnerRole>().notNull().default("NEW_HIRE"),
  dueDate: timestamp("due_date"),
  status: text("status").$type<OnboardingTaskStatus>().notNull().default("PENDING"),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by"),
  dependsOnTaskIds: jsonb("depends_on_task_ids").$type<number[]>().default([]),
  rowVersion: integer("row_version").default(1).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  updatedByMembershipId: integer("updated_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.templateStepId],
    foreignColumns: [onboardingTemplateSteps.orgId, onboardingTemplateSteps.id],
    name: "fk_onboarding_tasks_template_step_id_org",
  }),
  unique("uniq_onboarding_tasks_org_id").on(table.orgId, table.id),
  index("idx_onboarding_tasks_user").on(table.userId, table.orgId),
  index("idx_onboarding_tasks_status").on(table.orgId, table.status),
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_onboarding_tasks_created_actor",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_onboarding_tasks_updated_actor",
  }).onDelete("restrict"),
  check("chk_onboarding_tasks_row_version", sql`${table.rowVersion} > 0`),
  check(
    "chk_onboarding_tasks_owner_role",
    sql`${table.ownerRole} IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')`,
  ),
  check(
    "chk_onboarding_tasks_status",
    sql`${table.status} IN ('PENDING', 'COMPLETED')`,
  ),
]);

export const onboardingDocuments = pgTable("onboarding_documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  documentTypeId: integer("document_type_id").notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  version: integer("version").default(1).notNull(),
  status: onboardingDocumentStatusEnum("status").default("SUBMITTED").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  remarks: text("remarks"),
  rowVersion: integer("row_version").default(1).notNull(),
  updatedByMembershipId: integer("updated_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.documentTypeId], foreignColumns: [documentTypes.orgId, documentTypes.id], name: "fk_onboarding_documents_document_type_id_org" }),
  unique("uniq_onboarding_documents_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_onboarding_documents_org_user_type_version").on(
    table.orgId,
    table.userId,
    table.documentTypeId,
    table.version,
  ),
  index("idx_onboarding_docs_user").on(table.userId),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_onboarding_documents_updated_actor",
  }).onDelete("restrict"),
  check("chk_onboarding_documents_row_version", sql`${table.rowVersion} > 0`),
  check("chk_onboarding_documents_version_positive", sql`${table.version} > 0`),
]);

export const onboardingTemplatesRelations = relations(onboardingTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [onboardingTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [onboardingTemplates.createdBy], references: [users.id] }),
  steps: many(onboardingTemplateSteps),
}));

export const onboardingTemplateStepsRelations = relations(onboardingTemplateSteps, ({ one }) => ({
  template: one(onboardingTemplates, { fields: [onboardingTemplateSteps.templateId], references: [onboardingTemplates.id] }),
}));

export const onboardingTasksRelations = relations(onboardingTasks, ({ one }) => ({
  user: one(users, { fields: [onboardingTasks.userId], references: [users.id], relationName: "onboardingTaskUser" }),
  completedByUser: one(users, { fields: [onboardingTasks.completedBy], references: [users.id], relationName: "onboardingTaskCompletedBy" }),
  templateStep: one(onboardingTemplateSteps, { fields: [onboardingTasks.templateStepId], references: [onboardingTemplateSteps.id] }),
}));
