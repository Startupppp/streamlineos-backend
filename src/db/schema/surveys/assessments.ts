import { boolean, foreignKey, index, integer, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
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
  surveyId: integer("survey_id").notNull(),
  versionId: integer("version_id").notNull(),
  participantId: integer("participant_id"),
  sessionId: integer("session_id"),
  attemptNumber: integer("attempt_number").default(1).notNull(),
  status: surveyAssessmentAttemptStatusEnum("status").default("not_started").notNull(),
  score: integer("score"),
  passed: boolean("passed"),
  startedAt: timestamp("started_at"),
  submittedAt: timestamp("submitted_at"),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.participantId], foreignColumns: [surveyParticipants.orgId, surveyParticipants.id], name: "fk_survey_assessment_attempts_participant_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.sessionId], foreignColumns: [surveyResponseSessions.orgId, surveyResponseSessions.id], name: "fk_survey_assessment_attempts_session_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.surveyId], foreignColumns: [surveyForms.orgId, surveyForms.id], name: "fk_survey_assessment_attempts_survey_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.versionId], foreignColumns: [surveyVersions.orgId, surveyVersions.id], name: "fk_survey_assessment_attempts_version_id_org" }).onDelete("cascade"),
  index("idx_survey_assessment_attempts_survey_participant").on(table.surveyId, table.participantId),
  unique("uniq_survey_assessment_attempts_org_id").on(table.orgId, table.id),
]);

export const surveyCertificates = pgTable("survey_certificates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").notNull(),
  participantId: integer("participant_id").notNull(),
  attemptId: integer("attempt_id").notNull(),
  certificateNumber: text("certificate_number").notNull(),
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  fileUrl: text("file_url"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.attemptId], foreignColumns: [surveyAssessmentAttempts.orgId, surveyAssessmentAttempts.id], name: "fk_survey_certificates_attempt_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.participantId], foreignColumns: [surveyParticipants.orgId, surveyParticipants.id], name: "fk_survey_certificates_participant_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.surveyId], foreignColumns: [surveyForms.orgId, surveyForms.id], name: "fk_survey_certificates_survey_id_org" }).onDelete("cascade"),
  index("idx_survey_certificates_survey_participant").on(table.surveyId, table.participantId),
  unique("uq_survey_certificates_number").on(table.certificateNumber),
  unique("uniq_survey_certificates_org_id").on(table.orgId, table.id),
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
