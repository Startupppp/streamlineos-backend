import { pgTable, pgEnum, text, serial, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const surveyFormModeEnum = pgEnum("survey_form_mode", ["survey", "assessment", "live_session", "lead_qualification", "custom"]);
export const surveyFormStatusEnum = pgEnum("survey_form_status", ["draft", "testing", "published", "paused", "closed", "archived"]);

export const surveyForms = pgTable("survey_forms", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  mode: surveyFormModeEnum("mode").default("survey").notNull(),
  status: surveyFormStatusEnum("status").default("draft").notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  defaultLanguage: text("default_language").default("en").notNull(),
  activeVersionId: integer("active_version_id"),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  branding: jsonb("branding").$type<Record<string, unknown>>().default({}),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  archivedAt: timestamp("archived_at"),
}, (table) => [
  index("idx_survey_forms_org_status_mode").on(table.orgId, table.status, table.mode),
  unique("uniq_survey_forms_org_id").on(table.orgId, table.id),
]);

export const surveyVersions = pgTable("survey_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionNumber: integer("version_number").notNull(),
  schemaSnapshot: jsonb("schema_snapshot").$type<Record<string, unknown> | null>(),
  publishedAt: timestamp("published_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_versions_survey").on(table.surveyId),
  unique("uq_survey_versions_survey_number").on(table.surveyId, table.versionNumber),
  unique("uniq_survey_versions_org_id").on(table.orgId, table.id),
]);

export const surveyFormsRelations = relations(surveyForms, ({ one, many }) => ({
  organization: one(organizations, { fields: [surveyForms.orgId], references: [organizations.id] }),
  owner: one(users, { fields: [surveyForms.ownerUserId], references: [users.id] }),
  creator: one(users, { fields: [surveyForms.createdBy], references: [users.id] }),
  activeVersion: one(surveyVersions, { fields: [surveyForms.activeVersionId], references: [surveyVersions.id] }),
  versions: many(surveyVersions),
}));

export const surveyVersionsRelations = relations(surveyVersions, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyVersions.surveyId], references: [surveyForms.id] }),
  creator: one(users, { fields: [surveyVersions.createdBy], references: [users.id] }),
}));
