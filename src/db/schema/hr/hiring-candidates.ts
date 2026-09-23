import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, unique, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { candidateStatusEnum, applicationStatusEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { jobPostings } from "./hiring-core";

export const candidates = pgTable("candidates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  resumeUrl: text("resume_url"),
  linkedinUrl: text("linkedin_url"),
  portfolioUrl: text("portfolio_url"),
  currentCompany: text("current_company"),
  currentRole: text("current_role"),
  experienceYears: decimal("experience_years", { precision: 5, scale: 2 }),
  skills: text("skills").array(),
  source: text("source").default("DIRECT").notNull(),
  status: candidateStatusEnum("status").default("NEW").notNull(),
  notes: text("notes"),
  rating: integer("rating"),
  referredBy: text("referred_by").references(() => users.id),
  externalId: text("external_id"),
  duplicateOfId: integer("duplicate_of_id"),
  aiScore: integer("ai_score"),
  aiScoreBreakdown: jsonb("ai_score_breakdown").$type<Record<string, number>>(),
  aiScoreGeneratedAt: timestamp("ai_score_generated_at"),
  bgvStatus: text("bgv_status").$type<"NOT_INITIATED" | "INITIATED" | "PENDING" | "CLEARED" | "FAILED">().default("NOT_INITIATED"),
  bgvAgency: text("bgv_agency"),
  bgvNotes: text("bgv_notes"),
  bgvInitiatedAt: timestamp("bgv_initiated_at"),
  bgvCompletedAt: timestamp("bgv_completed_at"),
  sourceUrl: text("source_url"),
  location: text("location"),
  gender: text("gender").$type<"MALE" | "FEMALE" | "OTHER" | "PREFER_NOT_TO_SAY" | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.duplicateOfId], foreignColumns: [table.orgId, table.id], name: "fk_candidates_duplicate_of_id_org" }),
  unique("uniq_candidates_org_id").on(table.orgId, table.id),
  index("idx_candidates_status").on(table.status),
  index("idx_candidates_email").on(table.email),
  index("idx_candidates_org_status").on(table.orgId, table.status),
  index("idx_candidates_org_created").on(table.orgId, table.createdAt),
]);

export const candidateResumes = pgTable("candidate_resumes", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  resumeText: text("resume_text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_resumes_candidate_id_org" }).onDelete("cascade"),
  index("idx_candidate_resumes_org_candidate").on(table.orgId, table.candidateId),
  uniqueIndex("uniq_candidate_resumes_candidate_id").on(table.candidateId),
]);

export const candidateApplications = pgTable("candidate_applications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id").notNull(),
  status: applicationStatusEnum("status").default("APPLIED").notNull(),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
  coverLetter: text("cover_letter"),
  consentAt: timestamp("consent_at"),
  notes: text("notes"),
  trackingToken: text("tracking_token").unique(),
  screeningAnswers: jsonb("screening_answers").$type<Record<string, string>>(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_applications_org_candidate" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_candidate_applications_org_job_posting" }).onDelete("cascade"),
  unique("uniq_candidate_applications_org_id").on(table.orgId, table.id),
  index("idx_applications_candidate").on(table.candidateId),
  index("idx_applications_job").on(table.jobPostingId),
]);

export type ReferralStatus = "SUBMITTED" | "REVIEWING" | "HIRED" | "REJECTED" | "BONUS_PAID";

export const candidateReferrals = pgTable("candidate_referrals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  referredBy: text("referred_by").notNull(),
  referredByMembershipId: integer("referred_by_membership_id"),
  jobPostingId: integer("job_posting_id"),
  relationship: text("relationship"),
  notes: text("notes"),
  status: text("status").$type<ReferralStatus>().notNull().default("SUBMITTED"),
  bonusEligible: boolean("bonus_eligible").notNull().default(true),
  bonusAmount: decimal("bonus_amount", { precision: 12, scale: 2 }),
  bonusPaidAt: timestamp("bonus_paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_candidate_referrals_job_posting_id_org" }),
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_referrals_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_referrals_org_id").on(table.orgId, table.id),
  index("idx_referrals_candidate").on(table.candidateId),
  index("idx_referrals_referred_by").on(table.referredBy),
  index("idx_referrals_org_referred_by_membership").on(table.orgId, table.referredByMembershipId),
  foreignKey({
    columns: [table.orgId, table.referredByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_actor_8bce4f6f65893af6",
  }).onDelete("restrict"),
]);

export const candidateDocumentsVault = pgTable("candidate_documents_vault", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  documentType: text("document_type"),
  avResult: text("av_result").$type<"PENDING" | "CLEAN" | "INFECTED">().notNull().default("PENDING"),
  expiresAt: date("expires_at"),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_documents_vault_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_documents_vault_org_id").on(table.orgId, table.id),
  index("idx_vault_candidate").on(table.candidateId),
]);

export const vaultAccessLogs = pgTable("vault_access_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  vaultDocumentId: integer("vault_document_id"),
  filename: text("filename").notNull(),
  documentType: text("document_type"),
  accessedBy: text("accessed_by").notNull(),
  action: text("action").$type<"VIEW" | "DOWNLOAD" | "DELETE">().notNull().default("VIEW"),
  accessedAt: timestamp("accessed_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.vaultDocumentId], foreignColumns: [candidateDocumentsVault.orgId, candidateDocumentsVault.id], name: "fk_vault_access_logs_org_vault_document" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_vault_access_logs_org_candidate" }).onDelete("cascade"),
  unique("uniq_vault_access_logs_org_id").on(table.orgId, table.id),
  index("idx_vault_access_logs_org_candidate_accessed").on(table.orgId, table.candidateId, table.accessedAt.desc()),
  check("chk_vault_access_logs_action", sql`${table.action} IN ('VIEW', 'DOWNLOAD', 'DELETE')`),
]);

export const candidateReferenceChecks = pgTable("candidate_reference_checks", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  referenceName: text("reference_name").notNull(),
  referenceDesignation: text("reference_designation"),
  referenceCompany: text("reference_company"),
  referenceEmail: text("reference_email"),
  referencePhone: text("reference_phone"),
  relationship: text("relationship"),
  status: text("status").notNull().default("PENDING"),
  outcome: text("outcome"),
  notes: text("notes"),
  contactedAt: timestamp("contacted_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_reference_checks_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_reference_checks_org_id").on(table.orgId, table.id),
  index("idx_reference_checks_candidate").on(table.candidateId),
]);

export type CandidateMessageDirection = "INBOUND" | "OUTBOUND";
export type CandidateMessageChannel = "EMAIL" | "WHATSAPP" | "IN_APP";

export const candidateMessages = pgTable("candidate_messages", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  direction: text("direction").$type<CandidateMessageDirection>().notNull().default("OUTBOUND"),
  channel: text("channel").$type<CandidateMessageChannel>().notNull().default("EMAIL"),
  subject: text("subject"),
  body: text("body").notNull(),
  sentBy: text("sent_by"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
  externalId: text("external_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_messages_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_messages_org_id").on(table.orgId, table.id),
  index("idx_candidate_messages_candidate").on(table.candidateId),
  index("idx_candidate_messages_sent").on(table.sentAt),
]);

export const jobPostingsApplicationsRelations = relations(jobPostings, ({ many }) => ({
  applications: many(candidateApplications),
}));

export const candidateResumesRelations = relations(candidateResumes, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateResumes.candidateId], references: [candidates.id] }),
}));

export const candidateApplicationsRelations = relations(candidateApplications, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateApplications.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [candidateApplications.jobPostingId], references: [jobPostings.id] }),
}));

export const candidateReferralsRelations = relations(candidateReferrals, ({ one }) => ({
  organization: one(organizations, { fields: [candidateReferrals.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [candidateReferrals.candidateId], references: [candidates.id] }),
  referrer: one(users, { fields: [candidateReferrals.referredBy], references: [users.id] }),
  jobPosting: one(jobPostings, { fields: [candidateReferrals.jobPostingId], references: [jobPostings.id] }),
}));

export const candidateDocumentsVaultRelations = relations(candidateDocumentsVault, ({ one, many }) => ({
  organization: one(organizations, { fields: [candidateDocumentsVault.orgId], references: [organizations.id] }),
  uploader: one(users, { fields: [candidateDocumentsVault.uploadedBy], references: [users.id] }),
  accessLogs: many(vaultAccessLogs),
}));

export const vaultAccessLogsRelations = relations(vaultAccessLogs, ({ one }) => ({
  document: one(candidateDocumentsVault, { fields: [vaultAccessLogs.vaultDocumentId], references: [candidateDocumentsVault.id] }),
  accessor: one(users, { fields: [vaultAccessLogs.accessedBy], references: [users.id] }),
}));

export const candidateReferenceChecksRelations = relations(candidateReferenceChecks, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateReferenceChecks.candidateId], references: [candidates.id] }),
  organization: one(organizations, { fields: [candidateReferenceChecks.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [candidateReferenceChecks.createdBy], references: [users.id] }),
}));

export const candidateMessagesRelations = relations(candidateMessages, ({ one }) => ({
  organization: one(organizations, { fields: [candidateMessages.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [candidateMessages.candidateId], references: [candidates.id] }),
  sender: one(users, { fields: [candidateMessages.sentBy], references: [users.id] }),
}));
