import { foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { surveyForms } from "./forms";
import { surveyResponseSessions } from "./responses";

export const surveyAutomationEventStatusEnum = pgEnum("survey_automation_event_status", ["pending", "processed", "failed", "skipped"]);

export const surveyAutomationEvents = pgTable("survey_automation_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").notNull(),
  sessionId: integer("session_id"),
  eventType: text("event_type").notNull(),
  status: surveyAutomationEventStatusEnum("status").default("pending").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.sessionId], foreignColumns: [surveyResponseSessions.orgId, surveyResponseSessions.id], name: "fk_survey_automation_events_session_id_org" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.surveyId], foreignColumns: [surveyForms.orgId, surveyForms.id], name: "fk_survey_automation_events_survey_id_org" }).onDelete("cascade"),
  index("idx_survey_automation_events_org_survey_type").on(table.orgId, table.surveyId, table.eventType),
  unique("uniq_survey_automation_events_org_id").on(table.orgId, table.id),
]);

export const surveyAutomationEventsRelations = relations(surveyAutomationEvents, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyAutomationEvents.surveyId], references: [surveyForms.id] }),
  session: one(surveyResponseSessions, { fields: [surveyAutomationEvents.sessionId], references: [surveyResponseSessions.id] }),
}));
