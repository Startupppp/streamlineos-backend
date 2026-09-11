import { boolean, foreignKey, index, integer, jsonb, pgEnum, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const formTypeEnum = pgEnum("form_type", [
  "task_request",
  "bug_report",
  "feature_request",
  "change_request",
  "client_approval",
  "risk_report",
  "qa_issue",
  "generic",
]);

export const formSubmissionStatusEnum = pgEnum("form_submission_status", [
  "submitted",
  "processed",
  "rejected",
]);

export const projectForms = build.table("project_forms", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  formNumber: integer("form_number").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  type: formTypeEnum("type").notNull().default("generic"),
  fields: jsonb("fields")
    .$type<Array<{ key: string; label: string; type: string; required: boolean; options?: string[] }>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  actions: jsonb("actions")
    .$type<Array<{ type: string; config?: Record<string, unknown> }>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  isPublic: boolean("is_public").notNull().default(false),
  publicToken: text("public_token"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_forms_org_project" }).onDelete("cascade"),
  index("idx_project_forms_org_project").on(t.orgId, t.projectId).where(sql`deleted_at IS NULL`),
  uniqueIndex("uq_project_forms_project_number").on(t.projectId, t.formNumber),
  index("idx_project_forms_public_token").on(t.publicToken),
  unique("uniq_project_forms_org_id").on(t.orgId, t.id),
]);

export const formSubmissions = build.table("form_submissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  formId: integer("form_id").notNull(),
  projectId: integer("project_id").notNull(),
  values: jsonb("values")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  status: formSubmissionStatusEnum("status").notNull().default("submitted"),
  submittedByName: text("submitted_by_name"),
  submittedById: text("submitted_by_id").references(() => users.id, { onDelete: "set null" }),
  convertedTicketId: integer("converted_ticket_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.formId], foreignColumns: [projectForms.orgId, projectForms.id], name: "fk_form_submissions_org_form" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_form_submissions_org_project" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.convertedTicketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_form_submissions_org_ticket" }).onDelete("set null"),
  index("idx_form_submissions_form").on(t.formId),
  index("idx_form_submissions_org_project_status").on(t.orgId, t.projectId, t.status),
  unique("uniq_form_submissions_org_id").on(t.orgId, t.id),
]);
