import { pgTable, pgEnum, text, serial, integer, boolean, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { surveyForms, surveyVersions } from "./forms";

export const surveyQuestionTypeEnum = pgEnum("survey_question_type", [
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "dropdown",
  "rating",
  "star_rating",
  "nps",
  "number",
  "email",
  "phone",
  "date",
  "matrix",
  "likert",
  "ranking",
  "slider",
  "yes_no",
  "consent",
  "content_block",
]);

export const surveySections = pgTable("survey_sections", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_survey_sections_version").on(table.surveyId, table.versionId, table.sortOrder),
  unique("uniq_survey_sections_org_id").on(table.orgId, table.id),
]);

export const surveyQuestions = pgTable("survey_questions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  sectionId: integer("section_id").references(() => surveySections.id, { onDelete: "cascade" }).notNull(),
  questionKey: text("question_key").notNull(),
  variableName: text("variable_name"),
  type: surveyQuestionTypeEnum("type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  required: boolean("required").default(false).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  validation: jsonb("validation").$type<Record<string, unknown>>().default({}),
  scoring: jsonb("scoring").$type<Record<string, unknown>>().default({}),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_survey_questions_section").on(table.surveyId, table.versionId, table.sectionId, table.sortOrder),
  unique("uq_survey_questions_version_key").on(table.versionId, table.questionKey),
  unique("uniq_survey_questions_org_id").on(table.orgId, table.id),
]);

export const surveyQuestionChoices = pgTable("survey_question_choices", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  questionId: integer("question_id").references(() => surveyQuestions.id, { onDelete: "cascade" }).notNull(),
  choiceKey: text("choice_key").notNull(),
  label: text("label").notNull(),
  value: text("value"),
  score: integer("score").default(0),
  sortOrder: integer("sort_order").default(0).notNull(),
  isCorrect: boolean("is_correct").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_question_choices_question").on(table.questionId, table.sortOrder),
  unique("uq_survey_question_choices_question_key").on(table.questionId, table.choiceKey),
  unique("uniq_survey_question_choices_org_id").on(table.orgId, table.id),
]);

export const surveyLogicRules = pgTable("survey_logic_rules", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  surveyId: integer("survey_id").references(() => surveyForms.id, { onDelete: "cascade" }).notNull(),
  versionId: integer("version_id").references(() => surveyVersions.id, { onDelete: "cascade" }).notNull(),
  sourceQuestionId: integer("source_question_id").references(() => surveyQuestions.id, { onDelete: "cascade" }).notNull(),
  condition: jsonb("condition").$type<Record<string, unknown>>().notNull(),
  action: jsonb("action").$type<Record<string, unknown>>().notNull(),
  target: jsonb("target").$type<Record<string, unknown> | null>(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_logic_rules_source").on(table.surveyId, table.versionId, table.sourceQuestionId),
  unique("uniq_survey_logic_rules_org_id").on(table.orgId, table.id),
]);

export const surveySectionsRelations = relations(surveySections, ({ one, many }) => ({
  survey: one(surveyForms, { fields: [surveySections.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveySections.versionId], references: [surveyVersions.id] }),
  questions: many(surveyQuestions),
}));

export const surveyQuestionsRelations = relations(surveyQuestions, ({ one, many }) => ({
  survey: one(surveyForms, { fields: [surveyQuestions.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyQuestions.versionId], references: [surveyVersions.id] }),
  section: one(surveySections, { fields: [surveyQuestions.sectionId], references: [surveySections.id] }),
  choices: many(surveyQuestionChoices),
  logicRules: many(surveyLogicRules),
}));

export const surveyQuestionChoicesRelations = relations(surveyQuestionChoices, ({ one }) => ({
  question: one(surveyQuestions, { fields: [surveyQuestionChoices.questionId], references: [surveyQuestions.id] }),
}));

export const surveyLogicRulesRelations = relations(surveyLogicRules, ({ one }) => ({
  survey: one(surveyForms, { fields: [surveyLogicRules.surveyId], references: [surveyForms.id] }),
  version: one(surveyVersions, { fields: [surveyLogicRules.versionId], references: [surveyVersions.id] }),
  sourceQuestion: one(surveyQuestions, { fields: [surveyLogicRules.sourceQuestionId], references: [surveyQuestions.id] }),
}));
