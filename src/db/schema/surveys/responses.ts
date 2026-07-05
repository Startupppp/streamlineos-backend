import { pgTable, pgEnum, text, serial, integer, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
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
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  collectorId: integer("collector_id").references(() => surveyCollectors.id, { onDelete: "set null" }),
  participantId: integer("participant_id").references(() => surveyParticipants.id, { onDelete: "set null" }),
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
  index("idx_survey_response_sessions_survey_submitted").on(table.orgId, table.surveyId, table.submittedAt),
  index("idx_survey_response_sessions_collector").on(table.collectorId),
]);

export const surveyAnswers = pgTable("survey_answers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  sessionId: integer("session_id").references(() => surveyResponseSessions.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  questionId: integer("question_id").references(() => surveyQuestions.id, { onDelete: "cascade" }).notNull(),
  answerValue: jsonb("answer_value").$type<unknown>(),
  answerText: text("answer_text"),
  choiceIds: jsonb("choice_ids").$type<number[] | null>(),
  score: integer("score"),
  answeredAt: timestamp("answered_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_answers_org_question").on(table.orgId, table.questionId),
  index("idx_survey_answers_session").on(table.sessionId),
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
