import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  jobPostingStatusEnum, candidateStatusEnum, interviewTypeEnum,
  interviewResultEnum, applicationStatusEnum,
} from "../enums";
import { organizations, users } from "../auth";
import { departments } from "./employees";

export const hiringFlows = pgTable("hiring_flows", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_hiring_flows_org").on(table.orgId),
]);

export const hiringFlowRounds = pgTable("hiring_flow_rounds", {
  id: serial("id").primaryKey(),
  flowId: integer("flow_id").references(() => hiringFlows.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  roundType: text("round_type").$type<"HR_SCREENING" | "TECHNICAL" | "MANAGER" | "CULTURAL_FIT" | "FINAL" | "CUSTOM">().notNull().default("CUSTOM"),
  mode: text("mode").$type<"VIDEO" | "PHONE" | "ONSITE">().notNull().default("VIDEO"),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  slaDays: integer("sla_days"),
  questionBankTag: text("question_bank_tag"),
  scorecardTemplateId: integer("scorecard_template_id").references(() => scorecardTemplates.id),
  interviewerRoleRestriction: text("interviewer_role_restriction"),
  autoAdvanceThreshold: integer("auto_advance_threshold"),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_hiring_flow_rounds_flow").on(table.flowId),
]);

export const jobPostings = pgTable("job_postings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  departmentId: integer("department_id").references(() => departments.id),
  hiringFlowId: integer("hiring_flow_id").references(() => hiringFlows.id),
  location: text("location"),
  type: text("type").default("FULL_TIME").notNull(),
  experience: text("experience"),
  salaryMin: decimal("salary_min", { precision: 15, scale: 2 }),
  salaryMax: decimal("salary_max", { precision: 15, scale: 2 }),
  description: text("description"),
  requirements: text("requirements"),
  benefits: text("benefits"),
  status: jobPostingStatusEnum("status").default("DRAFT").notNull(),
  openings: integer("openings").default(1).notNull(),
  applicationDeadline: date("application_deadline"),
  closingDate: timestamp("closing_date"),
  postedBy: text("posted_by").references(() => users.id),
  externalPostingIds: jsonb("external_posting_ids").$type<Record<string, string>>(),
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_job_postings_org").on(table.orgId),
  index("idx_job_postings_status").on(table.status),
]);

export const candidateSources = pgTable("candidate_sources", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  oauthToken: text("oauth_token"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  lastSyncedAt: timestamp("last_synced_at"),
  lastSyncCount: integer("last_sync_count").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_candidate_sources_org").on(table.orgId),
  uniqueIndex("uq_candidate_sources_org_platform").on(table.orgId, table.platform),
]);

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
  duplicateOfId: integer("duplicate_of_id").references((): AnyPgColumn => candidates.id, { onDelete: "set null" }),
  resumeText: text("resume_text"),
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
  index("idx_candidates_org").on(table.orgId),
  index("idx_candidates_status").on(table.status),
  index("idx_candidates_email").on(table.email),
]);

export const candidateApplications = pgTable("candidate_applications", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id, { onDelete: "cascade" }).notNull(),
  status: applicationStatusEnum("status").default("APPLIED").notNull(),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
  coverLetter: text("cover_letter"),
  notes: text("notes"),
  trackingToken: text("tracking_token").unique(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_applications_candidate").on(table.candidateId),
  index("idx_applications_job").on(table.jobPostingId),
]);

export const interviews = pgTable("interviews", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id),
  interviewerId: text("interviewer_id").references(() => users.id),
  type: interviewTypeEnum("type").default("VIDEO").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  duration: integer("duration").default(60).notNull(),
  location: text("location"),
  meetingLink: text("meeting_link"),
  result: interviewResultEnum("result").default("PENDING").notNull(),
  feedback: text("feedback"),
  rating: integer("rating"),
  rubric: jsonb("rubric").$type<{ category: string; score: number; maxScore: number; comment?: string }[]>(),
  notes: text("notes"),
  recordingUrl: text("recording_url"),
  recordingPlatform: text("recording_platform"),
  panelInterviewerIds: jsonb("panel_interviewer_ids").$type<string[]>().default([]),
  remindersSent: jsonb("reminders_sent").$type<Record<string, boolean>>().notNull().default({}),
  calendarSyncToken: text("calendar_sync_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_interviews_candidate").on(table.candidateId),
  index("idx_interviews_interviewer").on(table.interviewerId),
  index("idx_interviews_scheduled").on(table.scheduledAt),
]);

export const scorecardTemplates = pgTable("scorecard_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  criteria: jsonb("criteria").$type<Array<{ name: string; weight: number }>>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_scorecard_templates_org").on(table.orgId),
]);

export const interviewScorecards = pgTable("interview_scorecards", {
  id: serial("id").primaryKey(),
  interviewId: integer("interview_id").references(() => interviews.id, { onDelete: "cascade" }).notNull(),
  interviewerId: text("interviewer_id").references(() => users.id).notNull(),
  templateId: integer("template_id").references(() => scorecardTemplates.id),
  ratings: jsonb("ratings").$type<Record<string, number>>().notNull().default({}),
  recommendation: text("recommendation").notNull().default("MAYBE"),
  notes: text("notes"),
  isBlindMode: boolean("is_blind_mode").notNull().default(false),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_scorecards_interview").on(table.interviewId),
  index("idx_scorecards_interviewer").on(table.interviewerId),
  uniqueIndex("uniq_scorecard_interview_interviewer").on(table.interviewId, table.interviewerId),
]);

export interface BookingSlot {
  start: string;
  end: string;
}

export const interviewBookingLinks = pgTable("interview_booking_links", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id),
  token: text("token").notNull().unique(),
  interviewerIds: jsonb("interviewer_ids").$type<string[]>().notNull().default([]),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  interviewType: text("interview_type").notNull().default("VIDEO"),
  availableSlots: jsonb("available_slots").$type<BookingSlot[]>().notNull().default([]),
  selectedSlot: timestamp("selected_slot"),
  status: text("status").$type<"pending" | "booked" | "expired" | "cancelled">().notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_booking_links_token").on(table.token),
  index("idx_booking_links_candidate").on(table.candidateId),
]);

export type ReferralStatus = "SUBMITTED" | "REVIEWING" | "HIRED" | "REJECTED" | "BONUS_PAID";

export const candidateReferrals = pgTable("candidate_referrals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  referredBy: text("referred_by").references(() => users.id).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id),
  relationship: text("relationship"),
  notes: text("notes"),
  status: text("status").$type<ReferralStatus>().notNull().default("SUBMITTED"),
  bonusEligible: boolean("bonus_eligible").notNull().default(true),
  bonusAmount: decimal("bonus_amount", { precision: 12, scale: 2 }),
  bonusPaidAt: timestamp("bonus_paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_referrals_candidate").on(table.candidateId),
  index("idx_referrals_referred_by").on(table.referredBy),
  index("idx_referrals_org").on(table.orgId),
]);

export const candidateReferralsRelations = relations(candidateReferrals, ({ one }) => ({
  organization: one(organizations, { fields: [candidateReferrals.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [candidateReferrals.candidateId], references: [candidates.id] }),
  referrer: one(users, { fields: [candidateReferrals.referredBy], references: [users.id] }),
  jobPosting: one(jobPostings, { fields: [candidateReferrals.jobPostingId], references: [jobPostings.id] }),
}));

export const calibrationSessions = pgTable("calibration_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id),
  scheduledAt: timestamp("scheduled_at"),
  status: text("status").$type<"pending" | "scheduled" | "completed" | "cancelled">().notNull().default("pending"),
  notes: text("notes"),
  decision: text("decision").$type<"STRONG_HIRE" | "HIRE" | "NO_HIRE" | "HOLD" | null>(),
  participantIds: jsonb("participant_ids").$type<string[]>().notNull().default([]),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_calibration_sessions_candidate").on(table.candidateId),
  index("idx_calibration_sessions_org").on(table.orgId),
]);

export const candidateDocumentsVault = pgTable("candidate_documents_vault", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  documentType: text("document_type"),
  avResult: text("av_result").$type<"PENDING" | "CLEAN" | "INFECTED">().notNull().default("PENDING"),
  expiresAt: date("expires_at"),
  uploadedBy: text("uploaded_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_vault_candidate").on(table.candidateId),
  index("idx_vault_org").on(table.orgId),
]);

export const vaultAccessLogs = pgTable("vault_access_logs", {
  id: serial("id").primaryKey(),
  vaultDocumentId: integer("vault_document_id").references(() => candidateDocumentsVault.id, { onDelete: "cascade" }).notNull(),
  accessedBy: text("accessed_by").references(() => users.id).notNull(),
  action: text("action").notNull().default("VIEW"),
  accessedAt: timestamp("accessed_at").defaultNow().notNull(),
});

export const interviewSlas = pgTable("interview_slas", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  maxHours: integer("max_hours").notNull().default(48),
  warningHours: integer("warning_hours").notNull().default(36),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_interview_sla_org_stage").on(table.orgId, table.stage),
]);

export const candidateSlaTracking = pgTable("candidate_sla_tracking", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  candidateId: integer("candidate_id").notNull().references(() => candidates.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  enteredAt: timestamp("entered_at").notNull().defaultNow(),
  breachedAt: timestamp("breached_at"),
  status: text("status").notNull().default("ON_TRACK"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_sla_tracking_candidate_stage").on(table.candidateId, table.stage),
  index("idx_sla_tracking_org_status").on(table.orgId, table.status),
  index("idx_sla_tracking_candidate").on(table.candidateId),
]);

export const interviewQuestions = pgTable("interview_questions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  category: text("category").notNull().default("GENERAL"),
  role: text("role"),
  difficulty: text("difficulty").notNull().default("MEDIUM"),
  tags: text("tags").array().default([]),
  sampleAnswer: text("sample_answer"),
  keywords: text("keywords").array().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_interview_questions_org").on(table.orgId),
  index("idx_interview_questions_category").on(table.orgId, table.category),
]);

export const candidateReferenceChecks = pgTable("candidate_reference_checks", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull().references(() => candidates.id, { onDelete: "cascade" }),
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
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_reference_checks_candidate").on(table.candidateId),
  index("idx_reference_checks_org").on(table.orgId),
]);

export const candidateOffers = pgTable("candidate_offers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  candidateId: integer("candidate_id").notNull().references(() => candidates.id, { onDelete: "cascade" }),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id),
  offeredBy: text("offered_by").references(() => users.id),
  offerStatus: text("offer_status").notNull().default("DRAFT"),
  offeredSalary: decimal("offered_salary", { precision: 15, scale: 2 }),
  offeredDesignation: text("offered_designation"),
  joiningDate: date("joining_date"),
  offerLetterUrl: text("offer_letter_url"),
  validUntil: date("valid_until"),
  notes: text("notes"),
  sentAt: timestamp("sent_at"),
  viewedAt: timestamp("viewed_at"),
  respondedAt: timestamp("responded_at"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  approvalRemarks: text("approval_remarks"),
  acceptanceToken: text("acceptance_token").unique(),
  acceptanceTokenExpiresAt: timestamp("acceptance_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_candidate_offers_candidate").on(table.candidateId),
  index("idx_candidate_offers_org").on(table.orgId),
]);

export const hiringFlowsRelations = relations(hiringFlows, ({ one, many }) => ({
  organization: one(organizations, { fields: [hiringFlows.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [hiringFlows.createdBy], references: [users.id] }),
  rounds: many(hiringFlowRounds),
  jobPostings: many(jobPostings),
}));

export const hiringFlowRoundsRelations = relations(hiringFlowRounds, ({ one }) => ({
  flow: one(hiringFlows, { fields: [hiringFlowRounds.flowId], references: [hiringFlows.id] }),
  scorecardTemplate: one(scorecardTemplates, { fields: [hiringFlowRounds.scorecardTemplateId], references: [scorecardTemplates.id] }),
}));

export const jobPostingsRelations = relations(jobPostings, ({ one, many }) => ({
  organization: one(organizations, { fields: [jobPostings.orgId], references: [organizations.id] }),
  department: one(departments, { fields: [jobPostings.departmentId], references: [departments.id] }),
  hiringFlow: one(hiringFlows, { fields: [jobPostings.hiringFlowId], references: [hiringFlows.id] }),
  postedByUser: one(users, { fields: [jobPostings.postedBy], references: [users.id] }),
  applications: many(candidateApplications),
}));

export const candidateSourcesRelations = relations(candidateSources, ({ one }) => ({
  organization: one(organizations, { fields: [candidateSources.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [candidateSources.createdBy], references: [users.id] }),
}));

export const candidatesRelations = relations(candidates, ({ many }) => ({
  applications: many(candidateApplications),
  interviews: many(interviews),
}));

export const candidateApplicationsRelations = relations(candidateApplications, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateApplications.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [candidateApplications.jobPostingId], references: [jobPostings.id] }),
}));

export const interviewsRelations = relations(interviews, ({ one, many }) => ({
  candidate: one(candidates, { fields: [interviews.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [interviews.jobPostingId], references: [jobPostings.id] }),
  interviewer: one(users, { fields: [interviews.interviewerId], references: [users.id] }),
  scorecards: many(interviewScorecards),
}));

export const scorecardTemplatesRelations = relations(scorecardTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [scorecardTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [scorecardTemplates.createdBy], references: [users.id] }),
  scorecards: many(interviewScorecards),
}));

export const interviewScorecardsRelations = relations(interviewScorecards, ({ one }) => ({
  interview: one(interviews, { fields: [interviewScorecards.interviewId], references: [interviews.id] }),
  interviewer: one(users, { fields: [interviewScorecards.interviewerId], references: [users.id] }),
  template: one(scorecardTemplates, { fields: [interviewScorecards.templateId], references: [scorecardTemplates.id] }),
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

export const interviewSlasRelations = relations(interviewSlas, ({ one }) => ({
  organization: one(organizations, { fields: [interviewSlas.orgId], references: [organizations.id] }),
}));

export const candidateSlaTrackingRelations = relations(candidateSlaTracking, ({ one }) => ({
  organization: one(organizations, { fields: [candidateSlaTracking.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [candidateSlaTracking.candidateId], references: [candidates.id] }),
}));

export const interviewQuestionsRelations = relations(interviewQuestions, ({ one }) => ({
  organization: one(organizations, { fields: [interviewQuestions.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [interviewQuestions.createdBy], references: [users.id] }),
}));

export const candidateReferenceChecksRelations = relations(candidateReferenceChecks, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateReferenceChecks.candidateId], references: [candidates.id] }),
  organization: one(organizations, { fields: [candidateReferenceChecks.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [candidateReferenceChecks.createdBy], references: [users.id] }),
}));

export const candidateOffersRelations = relations(candidateOffers, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateOffers.candidateId], references: [candidates.id] }),
  organization: one(organizations, { fields: [candidateOffers.orgId], references: [organizations.id] }),
  jobPosting: one(jobPostings, { fields: [candidateOffers.jobPostingId], references: [jobPostings.id] }),
  offeredByUser: one(users, { fields: [candidateOffers.offeredBy], references: [users.id] }),
}));

export const interviewBookingLinksRelations = relations(interviewBookingLinks, ({ one }) => ({
  candidate: one(candidates, { fields: [interviewBookingLinks.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [interviewBookingLinks.jobPostingId], references: [jobPostings.id] }),
  creator: one(users, { fields: [interviewBookingLinks.createdBy], references: [users.id] }),
}));

export type PipelineTrigger =
  | "STAGE_CHANGED"
  | "INTERVIEW_RESULT_SET"
  | "SLA_BREACHED"
  | "OFFER_SENT"
  | "OFFER_ACCEPTED"
  | "OFFER_REJECTED"
  | "SCORECARD_SUBMITTED";

export type PipelineAction =
  | "SEND_EMAIL"
  | "MOVE_TO_STAGE"
  | "CREATE_INTERVIEW"
  | "SEND_NOTIFICATION"
  | "NOTIFY_HIRING_MANAGER";

export const pipelineAutomations = pgTable("pipeline_automations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  trigger: text("trigger").$type<PipelineTrigger>().notNull(),
  triggerConditions: jsonb("trigger_conditions").$type<Record<string, unknown>>().default({}),
  action: text("action").$type<PipelineAction>().notNull(),
  actionPayload: jsonb("action_payload").$type<Record<string, unknown>>().default({}),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_pipeline_automations_org").on(table.orgId),
  index("idx_pipeline_automations_trigger").on(table.trigger),
]);

export const pipelineAutomationsRelations = relations(pipelineAutomations, ({ one }) => ({
  organization: one(organizations, { fields: [pipelineAutomations.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [pipelineAutomations.createdBy], references: [users.id] }),
}));

export const offerLetterTemplates = pgTable("offer_letter_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  htmlContent: text("html_content").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_offer_letter_templates_org").on(table.orgId),
]);

export const offerLetterTemplatesRelations = relations(offerLetterTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [offerLetterTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [offerLetterTemplates.createdBy], references: [users.id] }),
}));

export type EmailSequenceTrigger = "MANUAL" | "CANDIDATE_ADDED" | "APPLICATION_RECEIVED" | "STAGE_CHANGED" | "OFFER_SENT";
export type EmailSequenceEnrollmentStatus = "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "BOUNCED";

export const emailSequences = pgTable("email_sequences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  triggerType: text("trigger_type").$type<EmailSequenceTrigger>().notNull().default("MANUAL"),
  targetAudience: jsonb("target_audience").$type<Record<string, unknown>>().default({}),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_email_sequences_org").on(table.orgId),
]);

export const emailSequenceSteps = pgTable("email_sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").references(() => emailSequences.id, { onDelete: "cascade" }).notNull(),
  stepOrder: integer("step_order").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  subject: text("subject").notNull(),
  htmlBody: text("html_body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_email_sequence_steps_sequence").on(table.sequenceId),
]);

export const emailSequenceEnrollments = pgTable("email_sequence_enrollments", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").references(() => emailSequences.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  currentStep: integer("current_step").notNull().default(0),
  status: text("status").$type<EmailSequenceEnrollmentStatus>().notNull().default("ACTIVE"),
  enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
  nextSendAt: timestamp("next_send_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_email_sequence_enrollments_sequence").on(table.sequenceId),
  index("idx_email_sequence_enrollments_candidate").on(table.candidateId),
  index("idx_email_sequence_enrollments_next_send").on(table.nextSendAt),
]);

export const emailSequencesRelations = relations(emailSequences, ({ one, many }) => ({
  organization: one(organizations, { fields: [emailSequences.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [emailSequences.createdBy], references: [users.id] }),
  steps: many(emailSequenceSteps),
  enrollments: many(emailSequenceEnrollments),
}));

export const emailSequenceStepsRelations = relations(emailSequenceSteps, ({ one }) => ({
  sequence: one(emailSequences, { fields: [emailSequenceSteps.sequenceId], references: [emailSequences.id] }),
}));

export const emailSequenceEnrollmentsRelations = relations(emailSequenceEnrollments, ({ one }) => ({
  sequence: one(emailSequences, { fields: [emailSequenceEnrollments.sequenceId], references: [emailSequences.id] }),
  candidate: one(candidates, { fields: [emailSequenceEnrollments.candidateId], references: [candidates.id] }),
}));

export type VendorStatus = "ACTIVE" | "INACTIVE";
export type VendorPlacementStatus = "SUBMITTED" | "INTERVIEWING" | "PLACED" | "REJECTED";
export type VendorInvoiceStatus = "NOT_INVOICED" | "INVOICED" | "PAID";

export const recruitmentVendors = pgTable("recruitment_vendors", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  website: text("website"),
  feePercent: decimal("fee_percent", { precision: 5, scale: 2 }),
  status: text("status").$type<VendorStatus>().notNull().default("ACTIVE"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_recruitment_vendors_org").on(table.orgId),
]);

export const vendorCandidateSubmissions = pgTable("vendor_candidate_submissions", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").references(() => recruitmentVendors.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
  placementStatus: text("placement_status").$type<VendorPlacementStatus>().notNull().default("SUBMITTED"),
  invoiceStatus: text("invoice_status").$type<VendorInvoiceStatus>().notNull().default("NOT_INVOICED"),
  invoiceAmount: decimal("invoice_amount", { precision: 15, scale: 2 }),
  invoiceDate: date("invoice_date"),
  paidAt: date("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_vendor_submissions_vendor").on(table.vendorId),
  index("idx_vendor_submissions_candidate").on(table.candidateId),
]);

export const recruitmentVendorsRelations = relations(recruitmentVendors, ({ one, many }) => ({
  organization: one(organizations, { fields: [recruitmentVendors.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [recruitmentVendors.createdBy], references: [users.id] }),
  submissions: many(vendorCandidateSubmissions),
}));

export const vendorCandidateSubmissionsRelations = relations(vendorCandidateSubmissions, ({ one }) => ({
  vendor: one(recruitmentVendors, { fields: [vendorCandidateSubmissions.vendorId], references: [recruitmentVendors.id] }),
  candidate: one(candidates, { fields: [vendorCandidateSubmissions.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [vendorCandidateSubmissions.jobPostingId], references: [jobPostings.id] }),
}));

export type HeadcountRequestStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "JOB_CREATED";

export const headcountRequests = pgTable("headcount_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  departmentId: integer("department_id").references((): AnyPgColumn => departments.id),
  requestedBy: text("requested_by").references(() => users.id).notNull(),
  requestedRole: text("requested_role").notNull(),
  level: text("level"),
  justification: text("justification"),
  targetDate: date("target_date"),
  status: text("status").$type<HeadcountRequestStatus>().notNull().default("DRAFT"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectedReason: text("rejected_reason"),
  linkedJobPostingId: integer("linked_job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_headcount_requests_org").on(table.orgId),
  index("idx_headcount_requests_status").on(table.status),
  index("idx_headcount_requests_dept").on(table.departmentId),
]);

export const headcountRequestsRelations = relations(headcountRequests, ({ one }) => ({
  organization: one(organizations, { fields: [headcountRequests.orgId], references: [organizations.id] }),
  requestedByUser: one(users, { fields: [headcountRequests.requestedBy], references: [users.id] }),
  approvedByUser: one(users, { fields: [headcountRequests.approvedBy], references: [users.id] }),
  department: one(departments, { fields: [headcountRequests.departmentId], references: [departments.id] }),
  linkedJob: one(jobPostings, { fields: [headcountRequests.linkedJobPostingId], references: [jobPostings.id] }),
}));

export type CandidateMessageDirection = "INBOUND" | "OUTBOUND";
export type CandidateMessageChannel = "EMAIL" | "WHATSAPP" | "IN_APP";

export const candidateMessages = pgTable("candidate_messages", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  direction: text("direction").$type<CandidateMessageDirection>().notNull().default("OUTBOUND"),
  channel: text("channel").$type<CandidateMessageChannel>().notNull().default("EMAIL"),
  subject: text("subject"),
  body: text("body").notNull(),
  sentBy: text("sent_by").references(() => users.id),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
  externalId: text("external_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_candidate_messages_org").on(table.orgId),
  index("idx_candidate_messages_candidate").on(table.candidateId),
  index("idx_candidate_messages_sent").on(table.sentAt),
]);

export const candidateMessagesRelations = relations(candidateMessages, ({ one }) => ({
  organization: one(organizations, { fields: [candidateMessages.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [candidateMessages.candidateId], references: [candidates.id] }),
  sender: one(users, { fields: [candidateMessages.sentBy], references: [users.id] }),
}));

export type RecruiterActivityAction = "CALL_MADE" | "EMAIL_SENT" | "CANDIDATE_ADDED" | "NOTE_ADDED" | "INTERVIEW_SCHEDULED";

export const jobRecruiters = pgTable("job_recruiters", {
  id: serial("id").primaryKey(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  assignedBy: text("assigned_by").references(() => users.id).notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_job_recruiters_job_user").on(table.jobPostingId, table.userId),
  index("idx_job_recruiters_job").on(table.jobPostingId),
  index("idx_job_recruiters_user").on(table.userId),
]);

export const recruiterActivityLog = pgTable("recruiter_activity_log", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recruiterId: text("recruiter_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  action: text("action").$type<RecruiterActivityAction>().notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_recruiter_activity_org").on(table.orgId),
  index("idx_recruiter_activity_recruiter").on(table.recruiterId),
  index("idx_recruiter_activity_created").on(table.createdAt),
]);

export const jobRecruitersRelations = relations(jobRecruiters, ({ one }) => ({
  jobPosting: one(jobPostings, { fields: [jobRecruiters.jobPostingId], references: [jobPostings.id] }),
  user: one(users, { fields: [jobRecruiters.userId], references: [users.id] }),
  assignedByUser: one(users, { fields: [jobRecruiters.assignedBy], references: [users.id] }),
}));

export const recruiterActivityLogRelations = relations(recruiterActivityLog, ({ one }) => ({
  organization: one(organizations, { fields: [recruiterActivityLog.orgId], references: [organizations.id] }),
  recruiter: one(users, { fields: [recruiterActivityLog.recruiterId], references: [users.id] }),
  candidate: one(candidates, { fields: [recruiterActivityLog.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [recruiterActivityLog.jobPostingId], references: [jobPostings.id] }),
}));

export interface ReportConfig {
  entity: "candidates" | "jobs" | "interviews" | "offers";
  fields: string[];
  filters: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    departmentId?: number;
  };
}

export const scheduledReports = pgTable("scheduled_reports", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  reportConfig: jsonb("report_config").$type<ReportConfig>().notNull(),
  schedule: text("schedule").notNull(),
  recipients: text("recipients").array().notNull().default(sql`'{}'::text[]`),
  lastRunAt: timestamp("last_run_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_scheduled_reports_org").on(table.orgId),
]);

export const scheduledReportsRelations = relations(scheduledReports, ({ one }) => ({
  organization: one(organizations, { fields: [scheduledReports.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [scheduledReports.createdBy], references: [users.id] }),
}));
