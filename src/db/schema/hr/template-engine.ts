import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  integer,
  index,
  unique,
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { hrEmployments } from "./core-people";

export const hrTemplateKindEnum = pgEnum("hr_template_kind", [
  "onboarding_checklist",
  "offboarding_checklist",
  "probation_review",
  "performance_review",
  "goal",
  "letter",
  "document_request",
  "email",
  "notification",
  "survey",
  "training",
  "asset_assignment",
  "exit_interview",
]);

export const hrTemplateStatusEnum = pgEnum("hr_template_status", [
  "draft",
  "review",
  "approved",
  "active",
  "archived",
]);

export const hrLetterTypeEnum = pgEnum("hr_letter_type", [
  "offer",
  "appointment",
  "confirmation",
  "promotion",
  "transfer",
  "salary_revision",
  "warning",
  "experience",
  "relieving",
  "termination",
]);

export type ChecklistItem = {
  id: string;
  title: string;
  assigneeRole: "hr" | "manager" | "it" | "employee" | "buddy";
  dueOffsetDays: number;
  required: boolean;
  order: number;
};

export type ReviewSection = {
  id: string;
  title: string;
  questions: Array<{
    id: string;
    text: string;
    type: "rating" | "text" | "boolean";
    required: boolean;
  }>;
};

export type SurveyQuestion = {
  id: string;
  text: string;
  type: "rating" | "text" | "boolean" | "multiple_choice";
  options?: string[];
  required: boolean;
  order: number;
};

export type GoalItem = {
  id: string;
  title: string;
  description?: string;
  metricType: "numeric" | "percentage" | "boolean";
  targetValue?: number;
  required: boolean;
};

export type LetterEmailContent = {
  subject?: string;
  bodyHtml: string;
};

export type TemplateContent =
  | { kind: "onboarding_checklist" | "offboarding_checklist" | "asset_assignment"; items: ChecklistItem[] }
  | { kind: "probation_review" | "performance_review" | "exit_interview"; sections: ReviewSection[] }
  | { kind: "survey"; questions: SurveyQuestion[] }
  | { kind: "goal"; goals: GoalItem[] }
  | { kind: "letter" | "document_request" | "email" | "notification" | "training"; subject?: string; bodyHtml: string };

export const hrTemplates = pgTable("hr_templates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  kind: hrTemplateKindEnum("kind").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: hrTemplateStatusEnum("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  parentTemplateId: integer("parent_template_id").references((): AnyPgColumn => hrTemplates.id, { onDelete: "set null" }),
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
  variablesUsed: text("variables_used").array().default([]).notNull(),
  letterType: hrLetterTypeEnum("letter_type"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_templates_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_templates_org_kind_name_ver").on(table.orgId, table.kind, table.name, table.version),
  index("idx_hr_templates_org_kind").on(table.orgId, table.kind),
  index("idx_hr_templates_org_status").on(table.orgId, table.status),
]);

export const hrTemplateRenders = pgTable("hr_template_renders", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  templateId: integer("template_id").references(() => hrTemplates.id, { onDelete: "cascade" }).notNull(),
  templateVersion: integer("template_version").notNull(),
  renderedForEmployeeId: integer("rendered_for_employee_id").references(() => hrEmployments.id, { onDelete: "set null" }),
  renderedBy: text("rendered_by").references(() => users.id).notNull(),
  contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  outputHtml: text("output_html").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_template_renders_org_id").on(table.orgId, table.id),
  index("idx_hr_template_renders_org_template").on(table.orgId, table.templateId, table.createdAt),
]);

export const hrTemplatesRelations = relations(hrTemplates, ({ one, many }) => ({
  organization: one(organizations, { fields: [hrTemplates.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [hrTemplates.createdBy], references: [users.id] }),
  updater: one(users, { fields: [hrTemplates.updatedBy], references: [users.id] }),
  parent: one(hrTemplates, { fields: [hrTemplates.parentTemplateId], references: [hrTemplates.id] }),
  renders: many(hrTemplateRenders),
}));

export const hrTemplateRendersRelations = relations(hrTemplateRenders, ({ one }) => ({
  template: one(hrTemplates, { fields: [hrTemplateRenders.templateId], references: [hrTemplates.id] }),
  renderer: one(users, { fields: [hrTemplateRenders.renderedBy], references: [users.id] }),
}));
