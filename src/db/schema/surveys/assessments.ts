import { pgTable, pgEnum, text, serial, integer, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { surveyForms, surveyVersions } from "./forms";
import { surveyParticipants } from "./distribution";
import { surveyResponseSessions } from "./responses";

export const surveyAssessmentAttemptStatusEnum = pgEnum("survey_assessment_attempt_status", [
  "not_started",
  "in_progress",
  "submitted",
  "passed",
  "failed",
  "expired",
]);

export const surveyAssessmentAttempts = pgTable("survey_assessment_attempts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  participantId: integer("participant_id").references(() => surveyParticipants.id, { onDelete: "set null" }),
  sessionId: integer("session_id").references(() => surveyResponseSessions.id, { onDelete: "set null" }),
  attemptNumber: integer("attempt_number").default(1).notNull(),
  status: surveyAssessmentAttemptStatusEnum("status").default("not_started").notNull(),
  score: integer("score"),
  passed: boolean("passed"),
  startedAt: timestamp("started_at"),
  submittedAt: timestamp("submitted_at"),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_survey_assessment_attempts_survey_participant").on(table.surveyId, table.participantId),
]);

export const surveyCertificates = pgTable("survey_certificates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  participantId: integer("participant_id").references(() => surveyParticipants.id, { onDelete: "cascade" }).notNull(),
  attemptId: integer("attempt_id").references(() => surveyAssessmentAttempts.id, { onDelete: "cascade" }).notNull(),
  certificateNumber: text("certificate_number").notNull(),
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  fileUrl: text("file_url"),
}, (table) => [
  index("idx_survey_certificates_survey_participant").on(table.surveyId, table.participantId),
  unique("uq_survey_certificates_number").on(table.certificateNumber),
]);

export const surveyAssessmentAttemptsRelations = relations(surveyAssessmentAttempts, ({ one, many }) => ({
  survey: one(surveyForms, { fields: [surveyAssessmentAttempts.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyAssessmentAttempts.versionId], references: [surveyVersions.id] }),
  participant: one(surveyParticipants, { fields: [surveyAssessmentAttempts.participantId], references: [surveyParticipants.id] }),
  session: one(surveyResponseSessions, { fields: [surveyAssessmentAttempts.sessionId], references: [surveyResponseSessions.id] }),
  certificates: many(surveyCertificates),
}));

export const surveyCertificatesRelations = relations(surveyCertificates, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyCertificates.surveyId], references: [surveyForms.id] }),
  participant: one(surveyParticipants, { fields: [surveyCertificates.participantId], references: [surveyParticipants.id] }),
  attempt: one(surveyAssessmentAttempts, { fields: [surveyCertificates.attemptId], references: [surveyAssessmentAttempts.id] }),
}));
