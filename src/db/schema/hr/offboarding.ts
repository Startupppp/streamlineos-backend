import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  resignationStatusEnum, terminationStatusEnum, exitChecklistStatusEnum,
  docAuditActionEnum,
} from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { candidates } from "./hiring-candidates";
import { documentTemplates, documentTypes } from "./document-catalog";
import { onboardingDocuments } from "./onboarding";

export const candidateDocuments = pgTable("candidate_documents", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  templateId: integer("template_id"),
  title: text("title").notNull(),
  htmlContent: text("html_content").notNull().default(""),
  status: text("status").notNull().default("GENERATED"),
  externalDocId: text("external_doc_id"),
  sentAt: timestamp("sent_at"),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  declinedAt: timestamp("declined_at"),
  acceptanceDeadline: timestamp("acceptance_deadline"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_documents_org_candidate" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [documentTemplates.orgId, documentTemplates.id], name: "fk_candidate_documents_org_template" }),
  unique("uniq_candidate_documents_org_id").on(table.orgId, table.id),
  index("idx_candidate_docs_candidate").on(table.candidateId),
  index("idx_candidate_docs_external").on(table.externalDocId),
]);

export const documentTemplateVersions = pgTable("document_template_versions", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  htmlContent: text("html_content").notNull(),
  variables: jsonb("variables").$type<string[]>().notNull().default([]),
  archivedAt: timestamp("archived_at").defaultNow().notNull(),
  archivedBy: text("archived_by").notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [documentTemplates.orgId, documentTemplates.id], name: "fk_document_template_versions_template_id_org" }).onDelete("cascade"),
  unique("uniq_document_template_versions_org_id").on(table.orgId, table.id),
  index("idx_dtv_template_id").on(table.templateId),
]);

export const documentTypeRoles = pgTable("document_type_roles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  documentTypeId: integer("document_type_id").notNull(),
  roleSlug: text("role_slug").notNull(),
}, (table) => [
  uniqueIndex("uniq_document_type_roles_type_slug").on(table.documentTypeId, table.roleSlug),
  foreignKey({
    columns: [table.orgId, table.documentTypeId],
    foreignColumns: [documentTypes.orgId, documentTypes.id],
  }).onDelete("cascade"),
  unique("uniq_document_type_roles_org_id").on(table.orgId, table.id),
]);

export const documentAuditLogs = pgTable("document_audit_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  onboardingDocumentId: integer("onboarding_document_id").notNull(),
  action: docAuditActionEnum("action").notNull(),
  performedBy: text("performed_by").notNull(),
  remarks: text("remarks"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.onboardingDocumentId], foreignColumns: [onboardingDocuments.orgId, onboardingDocuments.id], name: "fk_document_audit_logs_onboarding_document_id_org" }),
  unique("uniq_document_audit_logs_org_id").on(table.orgId, table.id),
]);

export const resignations = pgTable("resignations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  reason: text("reason"),
  reasonCategory: text("reason_category"),
  lastWorkingDate: date("last_working_date"),
  noticePeriodDays: integer("notice_period_days").default(30).notNull(),
  status: resignationStatusEnum("status").default("SUBMITTED").notNull(),
  resignationLetterUrl: text("resignation_letter_url"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  hrReviewedBy: text("hr_reviewed_by"),
  hrReviewedAt: timestamp("hr_reviewed_at"),
  hrRemarks: text("hr_remarks"),
  finalReviewedBy: text("final_reviewed_by"),
  finalReviewedAt: timestamp("final_reviewed_at"),
  finalRemarks: text("final_remarks"),
  willingForExitInterview: boolean("willing_for_exit_interview").default(true).notNull(),
  companyFeedback: text("company_feedback"),
  exitInterviewNotes: text("exit_interview_notes"),
  exitInterviewDate: timestamp("exit_interview_date"),
  exitInterviewConductedBy: text("exit_interview_conducted_by"),
  feedback: jsonb("feedback").$type<{ question: string; answer: string }[]>(),
  userMembershipId: integer("user_membership_id"),
  rowVersion: integer("row_version").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_resignations_org_id").on(table.orgId, table.id),
  index("idx_resignations_user").on(table.userId),
  index("idx_resignations_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_resignations_user_actor",
  }).onDelete("set null"),
  check("chk_resignations_row_version", sql`${table.rowVersion} > 0`),
]);

export const exitChecklists = pgTable("exit_checklists", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  resignationId: integer("resignation_id").notNull(),
  item: text("item").notNull(),
  assignedTo: text("assigned_to"),
  assignedToMembershipId: integer("assigned_to_membership_id"),
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
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  reasons: text("reasons").array().notNull().default([]),
  detailedExplanation: text("detailed_explanation").notNull(),
  effectiveDate: date("effective_date").notNull(),
  severanceAmount: decimal("severance_amount", { precision: 15, scale: 2 }),
  noticePeriodWaived: boolean("notice_period_waived").default(false).notNull(),
  terminationLetterUrl: text("termination_letter_url"),
  supportingDocUrls: text("supporting_doc_urls").array().default([]),
  internalNotes: text("internal_notes"),
  status: terminationStatusEnum("status").default("DRAFT").notNull(),
  initiatedBy: text("initiated_by"),
  finalReviewedBy: text("final_reviewed_by"),
  finalReviewedAt: timestamp("final_reviewed_at"),
  finalRemarks: text("final_remarks"),
  emailSentAt: timestamp("email_sent_at"),
  emailStatus: text("email_status"),
  rowVersion: integer("row_version").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_terminations_org_id").on(table.orgId, table.id),
  index("idx_terminations_user").on(table.userId),
  index("idx_terminations_status").on(table.status),
  check("chk_terminations_row_version", sql`${table.rowVersion} > 0`),
]);

export const alumniProfiles = pgTable("alumni_profiles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
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
]);

export const backgroundVerifications = pgTable("background_verifications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
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
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
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
