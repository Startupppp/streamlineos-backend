import { pgTable, pgEnum, text, serial, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { clientAccounts } from "../crm/contacts";
import { surveyForms, surveyVersions } from "./forms";

export const surveyCollectorTypeEnum = pgEnum("survey_collector_type", [
  "public_link",
  "email",
  "qr",
  "embed",
  "popup",
  "crm_campaign",
  "hr_audience",
  "support_trigger",
  "live_session",
  "manual_access_code",
]);

export const surveyCollectorStatusEnum = pgEnum("survey_collector_status", ["active", "paused", "closed", "expired"]);

export const surveyParticipantStatusEnum = pgEnum("survey_participant_status", [
  "invited",
  "delivered",
  "opened",
  "started",
  "partial",
  "completed",
  "disqualified",
  "bounced",
  "unsubscribed",
  "expired",
]);

export const surveyCollectors = pgTable("survey_collectors", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "set null" }),
  collectorType: surveyCollectorTypeEnum("collector_type").notNull(),
  name: text("name").notNull(),
  token: text("token").notNull(),
  status: surveyCollectorStatusEnum("status").default("active").notNull(),
  source: text("source"),
  utm: jsonb("utm").$type<Record<string, unknown>>().default({}),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  opens: integer("opens").default(0).notNull(),
  starts: integer("starts").default(0).notNull(),
  completions: integer("completions").default(0).notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_survey_collectors_token").on(table.token),
  index("idx_survey_collectors_survey_status").on(table.surveyId, table.status),
  unique("uniq_survey_collectors_org_id").on(table.orgId, table.id),
]);

export const surveyParticipants = pgTable("survey_participants", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  collectorId: integer("collector_id").references(() => surveyCollectors.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  contactId: integer("contact_id"),
  leadId: integer("lead_id"),
  clientId: integer("client_id").references(() => clientAccounts.id, { onDelete: "set null" }),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  status: surveyParticipantStatusEnum("status").default("invited").notNull(),
  accessTokenHash: text("access_token_hash"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  invitedAt: timestamp("invited_at"),
  openedAt: timestamp("opened_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_participants_org_survey_status").on(table.orgId, table.surveyId, table.status),
  unique("uq_survey_participants_access_token_hash").on(table.accessTokenHash),
  unique("uniq_survey_participants_org_id").on(table.orgId, table.id),
]);

export const surveyCollectorsRelations = relations(surveyCollectors, ({ one, many }) => ({
  survey: one(surveyForms, { fields: [surveyCollectors.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyCollectors.versionId], references: [surveyVersions.id] }),
  participants: many(surveyParticipants),
}));

export const surveyParticipantsRelations = relations(surveyParticipants, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyParticipants.surveyId], references: [surveyForms.id] }),
  collector: one(surveyCollectors, { fields: [surveyParticipants.collectorId], references: [surveyCollectors.id] }),
  user: one(users, { fields: [surveyParticipants.userId], references: [users.id] }),
  client: one(clientAccounts, { fields: [surveyParticipants.clientId], references: [clientAccounts.id] }),
}));
