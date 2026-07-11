import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrFormStatusEnum = pgEnum("hr_form_status", ["draft", "active", "archived"]);
export const hrFormAudienceEnum = pgEnum("hr_form_audience", ["internal", "public"]);
export const hrFormSubmissionStatusEnum = pgEnum("hr_form_submission_status", [
  "submitted",
  "in_review",
  "approved",
  "rejected",
]);

export interface HrFormFieldConditional {
  fieldKey: string;
  operator: "eq" | "neq" | "contains" | "notEmpty";
  value?: unknown;
}

export interface HrFormFieldValidation {
  min?: number;
  max?: number;
  pattern?: string;
}

export interface HrFormField {
  key: string;
  label: string;
  type:
    | "text"
    | "long_text"
    | "number"
    | "date"
    | "select"
    | "multi_select"
    | "boolean"
    | "file"
    | "employee_ref"
    | "department_ref"
    | "currency";
  required: boolean;
  sensitive: boolean;
  options?: { label: string; value: string }[];
  conditional?: HrFormFieldConditional | null;
  validation?: HrFormFieldValidation | null;
}

export const hrForms = pgTable(
  "hr_forms",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: hrFormStatusEnum("status").notNull().default("draft"),
    audience: hrFormAudienceEnum("audience").notNull().default("internal"),
    workflowObjectType: text("workflow_object_type"),
    schema: jsonb("schema").$type<HrFormField[]>().notNull().default([]),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_forms_org_name").on(table.orgId, table.name),
    uniqueIndex("uniq_hr_forms_org_slug").on(table.orgId, table.slug),
    index("idx_hr_forms_org_status").on(table.orgId, table.status),
  ],
);

export const hrFormSubmissions = pgTable(
  "hr_form_submissions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    formId: integer("form_id")
      .references(() => hrForms.id, { onDelete: "cascade" })
      .notNull(),
    formSchemaSnapshot: jsonb("form_schema_snapshot").$type<HrFormField[]>().notNull(),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedByName: text("submitted_by_name"),
    subjectEmployeeId: integer("subject_employee_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    status: hrFormSubmissionStatusEnum("status").notNull().default("submitted"),
    workflowInstanceId: integer("workflow_instance_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_hr_form_subs_org_form_created").on(table.orgId, table.formId, table.createdAt),
    index("idx_hr_form_subs_org_status").on(table.orgId, table.status),
  ],
);

export const hrFormsRelations = relations(hrForms, ({ one, many }) => ({
  org: one(organizations, { fields: [hrForms.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [hrForms.createdBy], references: [users.id] }),
  submissions: many(hrFormSubmissions),
}));

export const hrFormSubmissionsRelations = relations(hrFormSubmissions, ({ one }) => ({
  org: one(organizations, { fields: [hrFormSubmissions.orgId], references: [organizations.id] }),
  form: one(hrForms, { fields: [hrFormSubmissions.formId], references: [hrForms.id] }),
  submitter: one(users, { fields: [hrFormSubmissions.submittedBy], references: [users.id] }),
}));
