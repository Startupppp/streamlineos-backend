import { pgTable, pgEnum, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { clientAccounts } from "./contacts";

export const npsSurveyStatusEnum = pgEnum("nps_survey_status", ["draft", "active", "closed"]);
export const npsCategoryEnum = pgEnum("nps_category", ["promoter", "passive", "detractor"]);

export const npsSurveys = pgTable("nps_surveys", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  question: text("question").notNull(),
  status: npsSurveyStatusEnum("status").default("draft").notNull(),
  publicToken: text("public_token").notNull().unique(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_nps_surveys_org_status").on(table.orgId, table.status),
]);

export const npsResponses = pgTable("nps_responses", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => npsSurveys.id, { onDelete: "cascade" }).notNull(),
  score: integer("score").notNull(),
  category: npsCategoryEnum("category").notNull(),
  comment: text("comment"),
  respondentName: text("respondent_name"),
  respondentEmail: text("respondent_email"),
  clientAccountId: integer("client_account_id").references(() => clientAccounts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_nps_responses_survey").on(table.surveyId),
]);

export const npsSurveysRelations = relations(npsSurveys, ({ one, many }) => ({
  organization: one(organizations, { fields: [npsSurveys.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [npsSurveys.createdBy], references: [users.id] }),
  responses: many(npsResponses),
}));

export const npsResponsesRelations = relations(npsResponses, ({ one }) => ({
  survey: one(npsSurveys, { fields: [npsResponses.surveyId], references: [npsSurveys.id] }),
  organization: one(organizations, { fields: [npsResponses.orgId], references: [organizations.id] }),
  clientAccount: one(clientAccounts, { fields: [npsResponses.clientAccountId], references: [clientAccounts.id] }),
}));
