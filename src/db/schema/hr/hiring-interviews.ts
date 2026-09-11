import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { interviewTypeEnum, interviewResultEnum } from "../common/enums";
import { organizationMembers, organizations, users } from "../common/auth";
import { scorecardTemplates, jobPostings } from "./hiring-core";
import { candidates, candidateApplications, candidateResumes } from "./hiring-candidates";

export const interviews = pgTable("interviews", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id"),
  interviewerId: text("interviewer_id"),
  interviewerMembershipId: integer("interviewer_membership_id"),
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
  remindersSent: jsonb("reminders_sent").$type<Record<string, boolean>>().notNull().default({}),
  calendarSyncToken: text("calendar_sync_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_interviews_candidate_id_org" }),
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_interviews_job_posting_id_org" }),
  unique("uniq_interviews_org_id").on(table.orgId, table.id),
  index("idx_interviews_candidate").on(table.candidateId),
  index("idx_interviews_interviewer").on(table.interviewerId),
  index("idx_interviews_scheduled").on(table.scheduledAt),
  index("idx_interviews_org_scheduled").on(table.orgId, table.scheduledAt),
  index("idx_interviews_org_interviewer_membership").on(table.orgId, table.interviewerMembershipId),
  foreignKey({ columns: [table.orgId, table.interviewerMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_interviews_interviewer_actor" }).onDelete("restrict"),
]);

export const interviewScorecards = pgTable("interview_scorecards", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  interviewId: integer("interview_id").notNull(),
  interviewerId: text("interviewer_id").notNull(),
  interviewerMembershipId: integer("interviewer_membership_id"),
  templateId: integer("template_id"),
  ratings: jsonb("ratings").$type<Record<string, number>>().notNull().default({}),
  recommendation: text("recommendation").notNull().default("MAYBE"),
  notes: text("notes"),
  isBlindMode: boolean("is_blind_mode").notNull().default(false),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.interviewId], foreignColumns: [interviews.orgId, interviews.id], name: "fk_interview_scorecards_org_interview" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [scorecardTemplates.orgId, scorecardTemplates.id], name: "fk_interview_scorecards_org_scorecard_template" }),
  index("idx_scorecards_interviewer").on(table.interviewerId),
  uniqueIndex("uniq_scorecard_interview_interviewer").on(table.interviewId, table.interviewerId),
  uniqueIndex("uniq_scorecard_interview_membership").on(table.interviewId, table.interviewerMembershipId),
  index("idx_scorecards_org_interviewer_membership").on(table.orgId, table.interviewerMembershipId),
  foreignKey({ columns: [table.orgId, table.interviewerMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_interview_scorecards_interviewer_actor" }).onDelete("restrict"),
]);

export interface BookingSlot {
  start: string;
  end: string;
}

export const interviewBookingLinks = pgTable("interview_booking_links", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id"),
  token: text("token").notNull().unique(),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  interviewType: text("interview_type").notNull().default("VIDEO"),
  availableSlots: jsonb("available_slots").$type<BookingSlot[]>().notNull().default([]),
  selectedSlot: timestamp("selected_slot"),
  status: text("status").$type<"pending" | "booked" | "expired" | "cancelled">().notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_interview_booking_links_job_posting_id_org" }),
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_interview_booking_links_org_candidate" }).onDelete("cascade"),
  unique("uniq_interview_booking_links_org_id").on(table.orgId, table.id),
  index("idx_booking_links_candidate").on(table.candidateId),
  index("idx_booking_links_org_created_by_membership").on(table.orgId, table.createdByMembershipId),
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_interview_booking_links_created_by_actor" }).onDelete("restrict"),
]);

export const interviewPanelMembers = pgTable("interview_panel_members", {
  id: serial("id").primaryKey(),
  interviewId: integer("interview_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.interviewId], foreignColumns: [interviews.orgId, interviews.id], name: "fk_interview_panel_members_org_interview" }).onDelete("cascade"),
  unique("uniq_interview_panel_members_org_id").on(table.orgId, table.id),
  uniqueIndex("uq_interview_panel_members_interview_user").on(table.interviewId, table.userId),
  index("idx_interview_panel_members_org_user").on(table.orgId, table.userId),
  uniqueIndex("uq_interview_panel_members_interview_membership").on(table.interviewId, table.userMembershipId),
  index("idx_interview_panel_members_org_membership").on(table.orgId, table.userMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_interview_panel_members_user_actor" }).onDelete("restrict"),
]);

export const bookingLinkInterviewers = pgTable("booking_link_interviewers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  bookingLinkId: integer("booking_link_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.bookingLinkId], foreignColumns: [interviewBookingLinks.orgId, interviewBookingLinks.id], name: "fk_booking_link_interviewers_org_booking_link" }).onDelete("cascade"),
  uniqueIndex("uq_booking_link_interviewers_link_user").on(table.bookingLinkId, table.userId),
  uniqueIndex("uq_booking_link_interviewers_link_membership").on(table.bookingLinkId, table.userMembershipId),
  index("idx_booking_link_interviewers_org_membership").on(table.orgId, table.userMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_booking_link_interviewers_user_actor" }).onDelete("restrict"),
]);

export const calibrationSessions = pgTable("calibration_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id"),
  scheduledAt: timestamp("scheduled_at"),
  status: text("status").$type<"pending" | "scheduled" | "completed" | "cancelled">().notNull().default("pending"),
  notes: text("notes"),
  decision: text("decision").$type<"STRONG_HIRE" | "HIRE" | "NO_HIRE" | "HOLD" | null>(),
  createdBy: text("created_by").notNull(),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_calibration_sessions_job_posting_id_org" }),
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_calibration_sessions_org_candidate" }).onDelete("cascade"),
  unique("uniq_calibration_sessions_org_id").on(table.orgId, table.id),
  index("idx_calibration_sessions_candidate").on(table.candidateId),
  index("idx_calibration_sessions_org_created_by_membership").on(table.orgId, table.createdByMembershipId),
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_calibration_sessions_created_by_actor" }).onDelete("restrict"),
]);

export const calibrationParticipants = pgTable("calibration_participants", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.sessionId], foreignColumns: [calibrationSessions.orgId, calibrationSessions.id], name: "fk_calibration_participants_org_session" }).onDelete("cascade"),
  unique("uniq_calibration_participants_org_id").on(table.orgId, table.id),
  uniqueIndex("uq_calibration_participants_session_user").on(table.sessionId, table.userId),
  index("idx_calibration_participants_org_user").on(table.orgId, table.userId),
  uniqueIndex("uq_calibration_participants_session_membership").on(table.sessionId, table.userMembershipId),
  index("idx_calibration_participants_org_membership").on(table.orgId, table.userMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_calibration_participants_user_actor" }).onDelete("restrict"),
]);

export const interviewSlas = pgTable("interview_slas", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  maxHours: integer("max_hours").notNull().default(48),
  warningHours: integer("warning_hours").notNull().default(36),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_interview_slas_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_interview_sla_org_stage").on(table.orgId, table.stage),
]);

export const candidateSlaTracking = pgTable("candidate_sla_tracking", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  candidateId: integer("candidate_id").notNull(),
  stage: text("stage").notNull(),
  enteredAt: timestamp("entered_at").notNull().defaultNow(),
  breachedAt: timestamp("breached_at"),
  status: text("status").notNull().default("ON_TRACK"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_candidate_sla_tracking_org_candidate" }).onDelete("cascade"),
  unique("uniq_candidate_sla_tracking_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_sla_tracking_candidate_stage").on(table.candidateId, table.stage),
  index("idx_sla_tracking_org_status").on(table.orgId, table.status),
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
  createdBy: text("created_by"),
  createdByMembershipId: integer("created_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_interview_questions_org_id").on(table.orgId, table.id),
  index("idx_interview_questions_category").on(table.orgId, table.category),
  index("idx_interview_questions_org_created_by_membership").on(table.orgId, table.createdByMembershipId),
  foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_interview_questions_created_by_actor" }).onDelete("restrict"),
]);

export const interviewsRelations = relations(interviews, ({ one, many }) => ({
  candidate: one(candidates, { fields: [interviews.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [interviews.jobPostingId], references: [jobPostings.id] }),
  interviewer: one(users, { fields: [interviews.interviewerId], references: [users.id] }),
  scorecards: many(interviewScorecards),
  panelMembers: many(interviewPanelMembers),
}));

export const interviewScorecardsRelations = relations(interviewScorecards, ({ one }) => ({
  interview: one(interviews, { fields: [interviewScorecards.interviewId], references: [interviews.id] }),
  interviewer: one(users, { fields: [interviewScorecards.interviewerId], references: [users.id] }),
  template: one(scorecardTemplates, { fields: [interviewScorecards.templateId], references: [scorecardTemplates.id] }),
}));

export const interviewBookingLinksRelations = relations(interviewBookingLinks, ({ one, many }) => ({
  candidate: one(candidates, { fields: [interviewBookingLinks.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [interviewBookingLinks.jobPostingId], references: [jobPostings.id] }),
  creator: one(users, { fields: [interviewBookingLinks.createdBy], references: [users.id] }),
  interviewers: many(bookingLinkInterviewers),
}));

export const interviewPanelMembersRelations = relations(interviewPanelMembers, ({ one }) => ({
  interview: one(interviews, { fields: [interviewPanelMembers.interviewId], references: [interviews.id] }),
  organization: one(organizations, { fields: [interviewPanelMembers.orgId], references: [organizations.id] }),
  user: one(users, { fields: [interviewPanelMembers.userId], references: [users.id] }),
}));

export const bookingLinkInterviewersRelations = relations(bookingLinkInterviewers, ({ one }) => ({
  bookingLink: one(interviewBookingLinks, { fields: [bookingLinkInterviewers.bookingLinkId], references: [interviewBookingLinks.id] }),
  user: one(users, { fields: [bookingLinkInterviewers.userId], references: [users.id] }),
}));

export const calibrationSessionsRelations = relations(calibrationSessions, ({ one, many }) => ({
  organization: one(organizations, { fields: [calibrationSessions.orgId], references: [organizations.id] }),
  candidate: one(candidates, { fields: [calibrationSessions.candidateId], references: [candidates.id] }),
  createdByUser: one(users, { fields: [calibrationSessions.createdBy], references: [users.id] }),
  participants: many(calibrationParticipants),
}));

export const calibrationParticipantsRelations = relations(calibrationParticipants, ({ one }) => ({
  session: one(calibrationSessions, { fields: [calibrationParticipants.sessionId], references: [calibrationSessions.id] }),
  organization: one(organizations, { fields: [calibrationParticipants.orgId], references: [organizations.id] }),
  user: one(users, { fields: [calibrationParticipants.userId], references: [users.id] }),
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

export const candidatesRelations = relations(candidates, ({ one, many }) => ({
  resume: one(candidateResumes, { fields: [candidates.id], references: [candidateResumes.candidateId] }),
  applications: many(candidateApplications),
  interviews: many(interviews),
}));

export const scorecardTemplateScorecardRelations = relations(scorecardTemplates, ({ many }) => ({
  scorecards: many(interviewScorecards),
}));
