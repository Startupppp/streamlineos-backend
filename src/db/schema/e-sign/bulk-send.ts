import { pgTable, serial, text, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { signBulkJobStatusEnum, signBulkRowStatusEnum } from "./enums";
import { signTemplates } from "./templates";
import { signEnvelopes } from "./envelopes";

export const signBulkSendJobs = pgTable(
  "sign_bulk_send_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    templateId: integer("template_id").references(() => signTemplates.id, { onDelete: "cascade" }).notNull(),
    senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }).notNull(),
    status: signBulkJobStatusEnum("status").default("pending").notNull(),
    columnMappingJson: jsonb("column_mapping_json").$type<Record<string, string>>().default({}).notNull(),
    totalCount: integer("total_count").default(0).notNull(),
    successCount: integer("success_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    csvFileKey: text("csv_file_key"),
    errorReportFileKey: text("error_report_file_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_sign_bulk_send_jobs_org_status").on(table.orgId, table.status),
    unique("uniq_sign_bulk_send_jobs_org_id").on(table.orgId, table.id),
  ],
);

export const signBulkSendRows = pgTable(
  "sign_bulk_send_rows",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").references(() => signBulkSendJobs.id, { onDelete: "cascade" }).notNull(),
    rowNumber: integer("row_number").notNull(),
    rawDataJson: jsonb("raw_data_json").$type<Record<string, unknown>>().notNull(),
    status: signBulkRowStatusEnum("status").default("pending").notNull(),
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_bulk_send_rows_job").on(table.jobId, table.rowNumber),
    index("idx_sign_bulk_send_rows_status").on(table.jobId, table.status),
  ],
);

export const signBulkSendJobsRelations = relations(signBulkSendJobs, ({ one, many }) => ({
  organization: one(organizations, { fields: [signBulkSendJobs.orgId], references: [organizations.id] }),
  template: one(signTemplates, { fields: [signBulkSendJobs.templateId], references: [signTemplates.id] }),
  rows: many(signBulkSendRows),
}));

export const signBulkSendRowsRelations = relations(signBulkSendRows, ({ one }) => ({
  job: one(signBulkSendJobs, { fields: [signBulkSendRows.jobId], references: [signBulkSendJobs.id] }),
  envelope: one(signEnvelopes, { fields: [signBulkSendRows.envelopeId], references: [signEnvelopes.id] }),
}));
