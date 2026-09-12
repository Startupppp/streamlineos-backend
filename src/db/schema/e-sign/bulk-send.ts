import { pgTable, serial, text, integer, jsonb, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { signBulkJobStatusEnum, signBulkRowStatusEnum } from "./enums";
import { signTemplates } from "./templates";
import { signEnvelopes } from "./envelopes";

export const signBulkSendJobs = pgTable(
  "sign_bulk_send_jobs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    templateId: integer("template_id").notNull(),
    senderMembershipId: integer("sender_membership_id"),
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
  foreignKey({ columns: [table.orgId, table.templateId], foreignColumns: [signTemplates.orgId, signTemplates.id], name: "fk_sign_bulk_send_jobs_template_id_org" }).onDelete("cascade"),
    index("idx_sign_bulk_send_jobs_org_status").on(table.orgId, table.status),
    unique("uniq_sign_bulk_send_jobs_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.senderMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_sign_bulk_org_sender_mbr",
    }).onDelete("set null"),
  ],
);

export const signBulkSendRows = pgTable(
  "sign_bulk_send_rows",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    jobId: integer("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    rawDataJson: jsonb("raw_data_json").$type<Record<string, unknown>>().notNull(),
    status: signBulkRowStatusEnum("status").default("pending").notNull(),
    envelopeId: integer("envelope_id"),
    errorMessage: text("error_message"),
    /**
     * Tries for THIS row, not for the job. One bad address in a spreadsheet of
     * five hundred must not stop the other four hundred and ninety-nine, and
     * must not be retried forever either.
     */
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({ columns: [table.orgId, table.jobId], foreignColumns: [signBulkSendJobs.orgId, signBulkSendJobs.id], name: "fk_sign_bulk_send_rows_job_id_org" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.envelopeId], foreignColumns: [signEnvelopes.orgId, signEnvelopes.id], name: "fk_sign_bulk_send_rows_envelope_id_org" }).onDelete("set null"),
    unique("uniq_sign_bulk_send_rows_org_id").on(table.orgId, table.id),
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
