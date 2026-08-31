import { pgTable, pgEnum, text, serial, integer, jsonb, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { surveyForms, surveyVersions } from "./forms";
import { surveyQuestions } from "./structure";

export const surveyLiveSessionStatusEnum = pgEnum("survey_live_session_status", ["draft", "waiting", "active", "paused", "ended"]);

export const surveyLiveSessions = pgTable("survey_live_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  hostUserId: text("host_user_id").references(() => users.id, { onDelete: "set null" }),
  hostMembershipId: integer("host_membership_id"),
  sessionCode: text("session_code").notNull(),
  status: surveyLiveSessionStatusEnum("status").default("draft").notNull(),
  currentQuestionId: integer("current_question_id").references(() => surveyQuestions.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_survey_live_sessions_code").on(table.sessionCode),
  index("idx_survey_live_sessions_survey").on(table.surveyId),
  unique("uniq_survey_live_sessions_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.hostMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_survey_live_org_host_mbr",
  }).onDelete("set null"),
]);

export const surveyLiveSessionsRelations = relations(surveyLiveSessions, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyLiveSessions.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyLiveSessions.versionId], references: [surveyVersions.id] }),
  host: one(users, { fields: [surveyLiveSessions.hostUserId], references: [users.id] }),
  currentQuestion: one(surveyQuestions, { fields: [surveyLiveSessions.currentQuestionId], references: [surveyQuestions.id] }),
}));
