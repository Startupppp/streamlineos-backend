import { boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../common/auth";
import { surveyForms, surveyVersions } from "./forms";
import { surveyQuestions } from "./structure";
import { surveyCollectors, surveyParticipants } from "./distribution";

export const surveyResponseSessionStatusEnum = pgEnum("survey_response_session_status", [
  "in_progress",
  "submitted",
  "invalid",
  "excluded",
  "deleted_by_policy",
]);

export const surveyResponseSessions = pgTable("survey_response_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").notNull(),
  versionId: integer("version_id").notNull(),
  collectorId: integer("collector_id"),
  participantId: integer("participant_id"),
  status: surveyResponseSessionStatusEnum("status").default("in_progress").notNull(),
  anonymous: boolean("anonymous").default(false).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  submittedAt: timestamp("submitted_at"),
  durationSeconds: integer("duration_seconds"),
  score: integer("score"),
  passed: boolean("passed"),
  segment: text("segment"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.collectorId], foreignColumns: [surveyCollectors.orgId, surveyCollectors.id], name: "fk_survey_response_sessions_collector_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.participantId], foreignColumns: [surveyParticipants.orgId, surveyParticipants.id], name: "fk_survey_response_sessions_participant_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.surveyId], foreignColumns: [surveyForms.orgId, surveyForms.id], name: "fk_survey_response_sessions_survey_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.versionId], foreignColumns: [surveyVersions.orgId, surveyVersions.id], name: "fk_survey_response_sessions_version_id_org" }).onDelete("cascade"),
  index("idx_survey_response_sessions_survey_submitted").on(table.orgId, table.surveyId, table.submittedAt),
  index("idx_survey_response_sessions_collector").on(table.collectorId),
  index("idx_survey_response_sessions_org_live_session").on(table.orgId, sql`((metadata->>'liveSessionId'))`),
  unique("uniq_survey_response_sessions_org_id").on(table.orgId, table.id),
]);

export const surveyAnswers = pgTable("survey_answers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  sessionId: integer("session_id").notNull(),
  surveyId: integer("survey_id").notNull(),
  versionId: integer("version_id").notNull(),
  questionId: integer("question_id").notNull(),
  answerValue: jsonb("answer_value").$type<unknown>(),
  answerText: text("answer_text"),
  choiceIds: jsonb("choice_ids").$type<number[] | null>(),
  score: integer("score"),
  answeredAt: timestamp("answered_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.questionId], foreignColumns: [surveyQuestions.orgId, surveyQuestions.id], name: "fk_survey_answers_question_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.sessionId], foreignColumns: [surveyResponseSessions.orgId, surveyResponseSessions.id], name: "fk_survey_answers_session_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.surveyId], foreignColumns: [surveyForms.orgId, surveyForms.id], name: "fk_survey_answers_survey_id_org" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.versionId], foreignColumns: [surveyVersions.orgId, surveyVersions.id], name: "fk_survey_answers_version_id_org" }).onDelete("cascade"),
  index("idx_survey_answers_org_question").on(table.orgId, table.questionId),
  index("idx_survey_answers_session").on(table.sessionId),
  unique("uniq_survey_answers_org_id").on(table.orgId, table.id),
]);

export const surveyResponseSessionsRelations = relations(surveyResponseSessions, ({ one, many }) => ({
  survey: one(surveyForms, { fields: [surveyResponseSessions.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyResponseSessions.versionId], references: [surveyVersions.id] }),
  collector: one(surveyCollectors, { fields: [surveyResponseSessions.collectorId], references: [surveyCollectors.id] }),
  participant: one(surveyParticipants, { fields: [surveyResponseSessions.participantId], references: [surveyParticipants.id] }),
  answers: many(surveyAnswers),
}));

export const surveyAnswersRelations = relations(surveyAnswers, ({ one }) => ({
  session: one(surveyResponseSessions, { fields: [surveyAnswers.sessionId], references: [surveyResponseSessions.id] }),
  question: one(surveyQuestions, { fields: [surveyAnswers.questionId], references: [surveyQuestions.id] }),
}));
