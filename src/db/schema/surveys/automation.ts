import { pgTable, pgEnum, text, serial, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { surveyForms } from "./forms";
import { surveyResponseSessions } from "./responses";

export const surveyAutomationEventStatusEnum = pgEnum("survey_automation_event_status", ["pending", "processed", "failed", "skipped"]);

export const surveyAutomationEvents = pgTable("survey_automation_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  sessionId: integer("session_id").references(() => surveyResponseSessions.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  status: surveyAutomationEventStatusEnum("status").default("pending").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  index("idx_survey_automation_events_org_survey_type").on(table.orgId, table.surveyId, table.eventType),
]);

export const surveyAutomationEventsRelations = relations(surveyAutomationEvents, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyAutomationEvents.surveyId], references: [surveyForms.id] }),
  session: one(surveyResponseSessions, { fields: [surveyAutomationEvents.sessionId], references: [surveyResponseSessions.id] }),
}));
