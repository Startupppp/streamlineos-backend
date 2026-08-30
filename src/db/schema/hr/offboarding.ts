import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  resignationStatusEnum, terminationStatusEnum, exitChecklistStatusEnum,
  onboardingDocumentStatusEnum, docAuditActionEnum,
} from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { candidates } from "./hiring-candidates";

type OnboardingTaskOwnerRole = "NEW_HIRE" | "HR" | "MANAGER" | "IT";
type OnboardingTaskStatus = "PENDING" | "COMPLETED";

export const documentTemplates = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  type: text("type").notNull().default("OFFER"),
  htmlContent: text("html_content").notNull().default(""),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_document_templates_org_id").on(table.orgId, table.id),
  index("idx_doc_templates_org").on(table.orgId, table.type),
]);

export const candidateDocuments = pgTable("candidate_documents", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  templateId: integer("template_id").references(() => documentTemplates.id),
  title: text("title").notNull(),
  htmlContent: text("html_content").notNull().default(""),
  status: text("status").notNull().default("GENERATED"),
  externalDocId: text("external_doc_id"),
  sentAt: timestamp("sent_at"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  declinedAt: timestamp("declined_at"),
  acceptanceDeadline: timestamp("acceptance_deadline"),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_candidate_documents_org_id").on(table.orgId, table.id),
  index("idx_candidate_docs_candidate").on(table.candidateId),
  index("idx_candidate_docs_external").on(table.externalDocId),
]);

export const documentTemplateVersions = pgTable("document_template_versions", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => documentTemplates.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  htmlContent: text("html_content").notNull(),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  archivedAt: timestamp("archived_at").defaultNow().notNull(),
  archivedBy: text("archived_by").notNull().references(() => users.id),
}, (table) => [
  unique("uniq_document_template_versions_org_id").on(table.orgId, table.id),
  index("idx_dtv_template_id").on(table.templateId),
]);

export const onboardingTemplates = pgTable("onboarding_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  departmentId: text("department_id").references(() => orgUnits.id, { onDelete: "set null" }),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_onboarding_templates_org_id").on(table.orgId, table.id),
  index("idx_onboarding_templates_org").on(table.orgId),
]);

export const onboardingTemplateSteps = pgTable("onboarding_template_steps", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => onboardingTemplates.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  ownerRole: text("owner_role").$type<OnboardingTaskOwnerRole>().notNull().default("NEW_HIRE"),
  dueOffsetDays: integer("due_offset_days").notNull().default(0),
  isRequired: boolean("is_required").notNull().default(true),
  isComplianceItem: boolean("is_compliance_item").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  check(
    "chk_onboarding_template_steps_owner_role",
    sql`${table.ownerRole} IN ('NEW_HIRE', 'HR', 'MANAGER', 'IT')`,
  ),
]);

export const onboardingTasks = pgTable("onboarding_tasks", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  templateStepId: integer("template_step_id").references(() => onboardingTemplateSteps.id),
  title: text("title").notNull(),
  description: text("description"),
  ownerRole: text("owner_role").$type<OnboardingTaskOwnerRole>().notNull().default("NEW_HIRE"),
  dueDate: timestamp("due_date"),
  status: text("status").$type<OnboardingTaskStatus>().notNull().default("PENDING"),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by").references(() => users.id),
  dependsOnTaskIds: jsonb("depends_on_task_ids").$type<number[]>().default([]),
  rowVersion: integer("row_version").default(1).notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  updatedByMembershipId: integer("updated_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
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

export const documentTypes = pgTable("document_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  countryCode: text("country_code"),
  isMandatory: boolean("is_mandatory").default(true).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_document_types_org_id").on(table.orgId, table.id),
  index("idx_doc_types_org").on(table.orgId),
  index("idx_doc_types_org_country").on(table.orgId, table.countryCode),
]);

export const documentTypeRoles = pgTable("document_type_roles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentTypeId: integer("document_type_id").notNull(),
  roleSlug: text("role_slug").notNull(),
}, (table) => [
  uniqueIndex("uniq_document_type_roles_type_slug").on(table.documentTypeId, table.roleSlug),
  index("idx_document_type_roles_org").on(table.orgId),
  index("idx_document_type_roles_type").on(table.documentTypeId),
  foreignKey({
    columns: [table.orgId, table.documentTypeId],
    foreignColumns: [documentTypes.orgId, documentTypes.id],
  }).onDelete("cascade"),
  unique("uniq_document_type_roles_org_id").on(table.orgId, table.id),
]);

export const onboardingDocuments = pgTable("onboarding_documents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  documentTypeId: integer("document_type_id").references(() => documentTypes.id).notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  version: integer("version").default(1).notNull(),
  status: onboardingDocumentStatusEnum("status").default("SUBMITTED").notNull(),
  reviewedBy: text("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  remarks: text("remarks"),
  rowVersion: integer("row_version").default(1).notNull(),
  updatedByMembershipId: integer("updated_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_onboarding_documents_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_onboarding_documents_org_user_type_version").on(
    table.orgId,
    table.userId,
    table.documentTypeId,
    table.version,
  ),
  index("idx_onboarding_docs_user").on(table.userId),
  index("idx_onboarding_docs_org").on(table.orgId),
  foreignKey({
    columns: [table.orgId, table.updatedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_onboarding_documents_updated_actor",
  }).onDelete("restrict"),
  check("chk_onboarding_documents_row_version", sql`${table.rowVersion} > 0`),
  check("chk_onboarding_documents_version_positive", sql`${table.version} > 0`),
]);

export const documentAuditLogs = pgTable("document_audit_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  onboardingDocumentId: integer("onboarding_document_id").references(() => onboardingDocuments.id).notNull(),
  action: docAuditActionEnum("action").notNull(),
  performedBy: text("performed_by").references(() => users.id).notNull(),
  remarks: text("remarks"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_document_audit_logs_org_id").on(table.orgId, table.id),
]);

export const resignations = pgTable("resignations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  reason: text("reason"),
  reasonCategory: text("reason_category"),
  lastWorkingDate: date("last_working_date"),
  noticePeriodDays: integer("notice_period_days").default(30).notNull(),
  status: resignationStatusEnum("status").default("SUBMITTED").notNull(),
  resignationLetterUrl: text("resignation_letter_url"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  hrReviewedBy: text("hr_reviewed_by").references(() => users.id),
  hrReviewedAt: timestamp("hr_reviewed_at"),
  hrRemarks: text("hr_remarks"),
  finalReviewedBy: text("final_reviewed_by").references(() => users.id),
  finalReviewedAt: timestamp("final_reviewed_at"),
  finalRemarks: text("final_remarks"),
  willingForExitInterview: boolean("willing_for_exit_interview").default(true).notNull(),
  companyFeedback: text("company_feedback"),
  exitInterviewNotes: text("exit_interview_notes"),
  exitInterviewDate: timestamp("exit_interview_date"),
  exitInterviewConductedBy: text("exit_interview_conducted_by").references(() => users.id),
  feedback: jsonb("feedback").$type<{ question: string; answer: string }[]>(),
  rowVersion: integer("row_version").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_resignations_org_id").on(table.orgId, table.id),
  index("idx_resignations_org").on(table.orgId),
  index("idx_resignations_user").on(table.userId),
  check("chk_resignations_row_version", sql`${table.rowVersion} > 0`),
]);

export const exitChecklists = pgTable("exit_checklists", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  resignationId: integer("resignation_id").notNull(),
  item: text("item").notNull(),
  assignedTo: text("assigned_to").references(() => users.id),
  status: exitChecklistStatusEnum("status").default("PENDING").notNull(),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
}, (table) => [
  unique("uniq_exit_checklists_org_id").on(table.orgId, table.id),
  index("idx_exit_checklists_org_resignation").on(table.orgId, table.resignationId),
  foreignKey({
    columns: [table.orgId, table.resignationId],
    foreignColumns: [resignations.orgId, resignations.id],
  }).onDelete("cascade"),
]);

export const terminations = pgTable("terminations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  reasons: text("reasons").array().notNull().default([]),
  detailedExplanation: text("detailed_explanation").notNull(),
  effectiveDate: date("effective_date").notNull(),
  severanceAmount: decimal("severance_amount", { precision: 15, scale: 2 }),
  noticePeriodWaived: boolean("notice_period_waived").default(false).notNull(),
  terminationLetterUrl: text("termination_letter_url"),
  supportingDocUrls: text("supporting_doc_urls").array().default([]),
  internalNotes: text("internal_notes"),
  status: terminationStatusEnum("status").default("DRAFT").notNull(),
  initiatedBy: text("initiated_by").references(() => users.id),
  finalReviewedBy: text("final_reviewed_by").references(() => users.id),
  finalReviewedAt: timestamp("final_reviewed_at"),
  finalRemarks: text("final_remarks"),
  emailSentAt: timestamp("email_sent_at"),
  emailStatus: text("email_status"),
  rowVersion: integer("row_version").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_terminations_org_id").on(table.orgId, table.id),
  index("idx_terminations_org").on(table.orgId),
  index("idx_terminations_user").on(table.userId),
  index("idx_terminations_status").on(table.status),
  check("chk_terminations_row_version", sql`${table.rowVersion} > 0`),
]);

export const alumniProfiles = pgTable("alumni_profiles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  currentCompany: text("current_company"),
  currentRole: text("current_role"),
  linkedinUrl: text("linkedin_url"),
  email: text("email"),
  leftDate: date("left_date"),
  isOptedIn: boolean("is_opted_in").default(true).notNull(),
  rehireEligibility: boolean("rehire_eligibility").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_alumni_profiles_org_id").on(table.orgId, table.id),
  index("idx_alumni_org").on(table.orgId),
]);

export const backgroundVerifications = pgTable("background_verifications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  type: text("type").notNull(),
  status: text("status").default("PENDING").notNull(),
  provider: text("provider"),
  referenceNumber: text("reference_number"),
  result: text("result"),
  notes: text("notes"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_background_verifications_org_id").on(table.orgId, table.id),
  index("idx_bgv_user").on(table.userId),
]);

export const certifications = pgTable("certifications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  name: text("name").notNull(),
  issuingOrganization: text("issuing_organization"),
  issueDate: date("issue_date"),
  expiryDate: date("expiry_date"),
  credentialId: text("credential_id"),
  credentialUrl: text("credential_url"),
  documentUrl: text("document_url"),
  reminderSent: boolean("reminder_sent").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_certifications_org_id").on(table.orgId, table.id),
  index("idx_certifications_user").on(table.userId),
  index("idx_certifications_expiry").on(table.expiryDate),
]);

export const documentTemplatesRelations = relations(documentTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [documentTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [documentTemplates.createdBy], references: [users.id] }),
  candidateDocuments: many(candidateDocuments),
  versions: many(documentTemplateVersions),
}));

export const documentTemplateVersionsRelations = relations(documentTemplateVersions, ({ one }) => ({
  template: one(documentTemplates, { fields: [documentTemplateVersions.templateId], references: [documentTemplates.id] }),
  archivedByUser: one(users, { fields: [documentTemplateVersions.archivedBy], references: [users.id] }),
}));

export const candidateDocumentsRelations = relations(candidateDocuments, ({ one }) => ({
  template: one(documentTemplates, { fields: [candidateDocuments.templateId], references: [documentTemplates.id] }),
  organization: one(organizations, { fields: [candidateDocuments.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [candidateDocuments.createdBy], references: [users.id] }),
}));

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

export const resignationsRelations = relations(resignations, ({ one, many }) => ({
  user: one(users, { fields: [resignations.userId], references: [users.id] }),
  approver: one(users, { fields: [resignations.approvedBy], references: [users.id], relationName: "resignationApprover" }),
  hrReviewer: one(users, { fields: [resignations.hrReviewedBy], references: [users.id], relationName: "resignationHrReviewer" }),
  finalReviewer: one(users, { fields: [resignations.finalReviewedBy], references: [users.id], relationName: "resignationFinalReviewer" }),
  interviewer: one(users, { fields: [resignations.exitInterviewConductedBy], references: [users.id], relationName: "exitInterviewer" }),
  checklists: many(exitChecklists),
}));

export const exitChecklistsRelations = relations(exitChecklists, ({ one }) => ({
  resignation: one(resignations, { fields: [exitChecklists.resignationId], references: [resignations.id] }),
  assignee: one(users, { fields: [exitChecklists.assignedTo], references: [users.id] }),
}));

export const terminationsRelations = relations(terminations, ({ one }) => ({
  user: one(users, { fields: [terminations.userId], references: [users.id] }),
  initiator: one(users, { fields: [terminations.initiatedBy], references: [users.id], relationName: "terminationInitiator" }),
  finalReviewer: one(users, { fields: [terminations.finalReviewedBy], references: [users.id], relationName: "terminationFinalReviewer" }),
}));

export const alumniProfilesRelations = relations(alumniProfiles, ({ one }) => ({
  user: one(users, { fields: [alumniProfiles.userId], references: [users.id] }),
}));

export const backgroundVerificationsRelations = relations(backgroundVerifications, ({ one }) => ({
  user: one(users, { fields: [backgroundVerifications.userId], references: [users.id] }),
}));

export const certificationsRelations = relations(certifications, ({ one }) => ({
  user: one(users, { fields: [certifications.userId], references: [users.id] }),
}));

export const documentTypesRelations = relations(documentTypes, ({ one, many }) => ({
  organization: one(organizations, { fields: [documentTypes.orgId], references: [organizations.id] }),
  roles: many(documentTypeRoles),
}));

export const documentTypeRolesRelations = relations(documentTypeRoles, ({ one }) => ({
  documentType: one(documentTypes, {
    fields: [documentTypeRoles.orgId, documentTypeRoles.documentTypeId],
    references: [documentTypes.orgId, documentTypes.id],
  }),
}));
