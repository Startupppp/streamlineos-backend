import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { jobPostings } from "./hiring-core";
import { candidates } from "./hiring-candidates";

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
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_pipeline_automations_org_id").on(table.orgId, table.id),
  index("idx_pipeline_automations_trigger").on(table.trigger),
]);

export const offerLetterTemplates = pgTable("offer_letter_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  htmlContent: text("html_content").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_offer_letter_templates_org_id").on(table.orgId, table.id),
]);

export const candidateOffers = pgTable("candidate_offers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id"),
  offeredBy: text("offered_by"),
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
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  approvalRemarks: text("approval_remarks"),
  acceptanceToken: text("acceptance_token").unique(),
  acceptanceTokenExpiresAt: timestamp("acceptance_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_candidate_offers_job_posting_id_org" }),
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_offers_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_offers_org_id").on(table.orgId, table.id),
  index("idx_candidate_offers_candidate").on(table.candidateId),
  index("idx_candidate_offers_org_status").on(table.orgId, table.offerStatus),
]);

export const offerVersions = pgTable("offer_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  offerId: integer("offer_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  offeredSalary: decimal("offered_salary", { precision: 15, scale: 2 }),
  offeredDesignation: text("offered_designation"),
  joiningDate: date("joining_date"),
  validUntil: date("valid_until"),
  notes: text("notes"),
  changeReason: text("change_reason"),
  changedBy: text("changed_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.offerId], foreignColumns: [candidateOffers.orgId, candidateOffers.id], name: "fk_offer_versions_org_offer" }).onDelete("cascade"),
  unique("uniq_offer_versions_org_id").on(table.orgId, table.id),
  index("idx_offer_versions_offer").on(table.offerId),
]);

export type OfferNegotiationDirection = "CANDIDATE_COUNTER" | "INTERNAL_RESPONSE";

export const offerNegotiations = pgTable("offer_negotiations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  offerId: integer("offer_id").notNull(),
  direction: text("direction").$type<OfferNegotiationDirection>().notNull(),
  proposedSalary: decimal("proposed_salary", { precision: 15, scale: 2 }),
  proposedJoiningDate: date("proposed_joining_date"),
  message: text("message"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.offerId], foreignColumns: [candidateOffers.orgId, candidateOffers.id], name: "fk_offer_negotiations_org_offer" }).onDelete("cascade"),
  unique("uniq_offer_negotiations_org_id").on(table.orgId, table.id),
  index("idx_offer_negotiations_offer").on(table.offerId),
]);

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
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_email_sequences_org_id").on(table.orgId, table.id),
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

export type VendorStatus = "ACTIVE" | "INACTIVE";
export type VendorPlacementStatus = "SUBMITTED" | "INTERVIEWING" | "PLACED" | "REJECTED";
export type VendorInvoiceStatus = "NOT_INVOICED" | "INVOICED" | "PAID";
export type VendorContractType = "CONTINGENCY" | "CONTRACT_STAFFING" | "BOTH";

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
  contractType: text("contract_type").$type<VendorContractType>().notNull().default("CONTINGENCY"),
  slaDays: integer("sla_days"),
  replacementGuaranteeDays: integer("replacement_guarantee_days"),
  portalToken: text("portal_token"),
  portalTokenExpiresAt: timestamp("portal_token_expires_at"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_recruitment_vendors_org_id").on(table.orgId, table.id),
  uniqueIndex("idx_recruitment_vendors_portal_token").on(table.portalToken),
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
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }),
  payRate: decimal("pay_rate", { precision: 10, scale: 2 }),
  contractStartDate: date("contract_start_date"),
  contractEndDate: date("contract_end_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_vendor_submissions_vendor").on(table.vendorId),
  index("idx_vendor_submissions_candidate").on(table.candidateId),
]);

export type HeadcountRequestStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "JOB_CREATED";

export const headcountRequests = pgTable("headcount_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  orgDepartmentId: text("org_department_id"),
  requestedBy: text("requested_by").notNull(),
  requestedByMembershipId: integer("requested_by_membership_id"),
  requestedRole: text("requested_role").notNull(),
  level: text("level"),
  justification: text("justification"),
  targetDate: date("target_date"),
  status: text("status").$type<HeadcountRequestStatus>().notNull().default("DRAFT"),
  approvedBy: text("approved_by"),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  rejectedReason: text("rejected_reason"),
  linkedJobPostingId: integer("linked_job_posting_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.linkedJobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_headcount_requests_org_job_posting" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.orgDepartmentId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_headcount_requests_org_department" }).onDelete("set null"),
  unique("uniq_headcount_requests_org_id").on(table.orgId, table.id),
  index("idx_headcount_requests_status").on(table.status),
  index("idx_headcount_requests_org_dept").on(table.orgDepartmentId),
  index("idx_headcount_requests_org_requested_by_membership").on(table.orgId, table.requestedByMembershipId),
  index("idx_headcount_requests_org_approved_by_membership").on(table.orgId, table.approvedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.requestedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_actor_edcd74baae8dcf06",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_actor_b98269fd23c2381b",
  }).onDelete("restrict"),
]);

export type RecruiterActivityAction = "CALL_MADE" | "EMAIL_SENT" | "CANDIDATE_ADDED" | "NOTE_ADDED" | "INTERVIEW_SCHEDULED";

export const jobRecruiters = pgTable("job_recruiters", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  jobPostingId: integer("job_posting_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  assignedBy: text("assigned_by").notNull(),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_job_recruiters_org_job_posting" }).onDelete("cascade"),
  uniqueIndex("uq_job_recruiters_job_user").on(table.jobPostingId, table.userId),
  index("idx_job_recruiters_user").on(table.userId),
  index("idx_job_recruiters_org_job_user").on(table.orgId, table.jobPostingId, table.userId),
]);

export const recruiterActivityLog = pgTable("recruiter_activity_log", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  recruiterId: text("recruiter_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  action: text("action").$type<RecruiterActivityAction>().notNull(),
  candidateId: integer("candidate_id"),
  jobPostingId: integer("job_posting_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_recruiter_activity_log_org_candidate" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_recruiter_activity_log_org_job_posting" }).onDelete("set null"),
  unique("uniq_recruiter_activity_log_org_id").on(table.orgId, table.id),
  index("idx_recruiter_activity_recruiter").on(table.recruiterId),
  index("idx_recruiter_activity_created").on(table.createdAt),
]);

export interface ReportConfig {
  entity: "candidates" | "jobs" | "interviews" | "offers";
  fields: string[];
  filters: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    departmentId?: string;
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
  unique("uniq_scheduled_reports_org_id").on(table.orgId, table.id),
]);

export const pipelineAutomationsRelations = relations(pipelineAutomations, ({ one }) => ({
  organization: one(organizations, { fields: [pipelineAutomations.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [pipelineAutomations.createdBy], references: [users.id] }),
}));

export const offerLetterTemplatesRelations = relations(offerLetterTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [offerLetterTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [offerLetterTemplates.createdBy], references: [users.id] }),
}));

export const candidateOffersRelations = relations(candidateOffers, ({ one }) => ({
  candidate: one(candidates, { fields: [candidateOffers.candidateId], references: [candidates.id] }),
  organization: one(organizations, { fields: [candidateOffers.orgId], references: [organizations.id] }),
  jobPosting: one(jobPostings, { fields: [candidateOffers.jobPostingId], references: [jobPostings.id] }),
  offeredByUser: one(users, { fields: [candidateOffers.offeredBy], references: [users.id] }),
}));

export const offerVersionsRelations = relations(offerVersions, ({ one }) => ({
  offer: one(candidateOffers, { fields: [offerVersions.offerId], references: [candidateOffers.id] }),
  changedByUser: one(users, { fields: [offerVersions.changedBy], references: [users.id] }),
}));

export const offerNegotiationsRelations = relations(offerNegotiations, ({ one }) => ({
  offer: one(candidateOffers, { fields: [offerNegotiations.offerId], references: [candidateOffers.id] }),
  createdByUser: one(users, { fields: [offerNegotiations.createdBy], references: [users.id] }),
}));

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

export const headcountRequestsRelations = relations(headcountRequests, ({ one }) => ({
  organization: one(organizations, { fields: [headcountRequests.orgId], references: [organizations.id] }),
  requestedByUser: one(users, { fields: [headcountRequests.requestedBy], references: [users.id] }),
  approvedByUser: one(users, { fields: [headcountRequests.approvedBy], references: [users.id] }),
  orgDepartment: one(orgUnits, { fields: [headcountRequests.orgDepartmentId], references: [orgUnits.id] }),
  linkedJob: one(jobPostings, { fields: [headcountRequests.linkedJobPostingId], references: [jobPostings.id] }),
}));

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

export const scheduledReportsRelations = relations(scheduledReports, ({ one }) => ({
  organization: one(organizations, { fields: [scheduledReports.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [scheduledReports.createdBy], references: [users.id] }),
}));
