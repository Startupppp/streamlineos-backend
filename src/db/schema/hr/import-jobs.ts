import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrImportEntityEnum = pgEnum("hr_import_entity", [
  "employees",
  "leave_balances",
  "attendance",
  "assets",
  "document_metadata",
]);

export const hrImportStatusEnum = pgEnum("hr_import_status", [
  "validating",
  "previewed",
  "committing",
  "committed",
  "rolled_back",
  "failed",
]);

export const hrImportRowStatusEnum = pgEnum("hr_import_row_status", [
  "valid",
  "error",
  "committed",
]);

export const hrImportJobs = pgTable(
  "hr_import_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    entity: hrImportEntityEnum("entity").notNull(),
    fileName: text("file_name").notNull(),
    status: hrImportStatusEnum("status").default("validating").notNull(),
    totalRows: integer("total_rows").default(0).notNull(),
    validRows: integer("valid_rows").default(0).notNull(),
    errorRows: integer("error_rows").default(0).notNull(),
    errors: jsonb("errors").$type<Array<{ row: number; field?: string; message: string }>>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    committedAt: timestamp("committed_at"),
    rolledBackAt: timestamp("rolled_back_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_hr_import_jobs_org").on(table.orgId, table.createdAt),
  ],
);

export const hrImportRows = pgTable(
  "hr_import_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .references(() => hrImportJobs.id, { onDelete: "cascade" })
      .notNull(),
    rowNumber: integer("row_number").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: hrImportRowStatusEnum("status").default("valid").notNull(),
    error: text("error"),
    createdRecordRef: jsonb("created_record_ref").$type<{ table: string; id: string | number } | null>(),
  },
  (table) => [
    index("idx_hr_import_rows_job_status").on(table.jobId, table.status),
  ],
);

export const hrImportJobsRelations = relations(hrImportJobs, ({ many }) => ({
  rows: many(hrImportRows),
}));

export const hrImportRowsRelations = relations(hrImportRows, ({ one }) => ({
  job: one(hrImportJobs, {
    fields: [hrImportRows.jobId],
    references: [hrImportJobs.id],
  }),
}));
