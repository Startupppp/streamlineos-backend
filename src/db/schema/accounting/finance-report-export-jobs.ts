import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";

export type FinanceReportExportJobStatus = "pending" | "running" | "completed" | "failed" | "expired" | "cancelled";

export type FinanceReportType =
  | "vendor_statement"
  | "customer_statement"
  | "sales_by_customer"
  | "sales_by_item"
  | "expense_by_category"
  | "tax_summary"
  | "project_profitability"
  | "department_profitability"
  | "budget_vs_actual";

export interface FinanceReportExportFilters {
  reportType: FinanceReportType;
  from: string;
  to: string;
  vendorId?: number;
  clientId?: number;
  budgetId?: number;
}

export const financeReportExportJobs = pgTable("finance_report_export_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requestedByMembershipId: integer("requested_by_membership_id"),
  reportType: text("report_type").$type<FinanceReportType>().notNull(),
  status: text("status").$type<FinanceReportExportJobStatus>().notNull().default("pending"),
  filters: jsonb("filters").$type<FinanceReportExportFilters>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  fileKey: text("file_key"),
  fileName: text("file_name"),
  mimeType: text("mime_type").notNull().default("text/csv"),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  processedRows: integer("processed_rows").notNull().default(0),
  rowCount: integer("row_count"),
  truncated: boolean("truncated").notNull().default(false),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uniq_fin_report_export_jobs_org_idempotency").on(table.orgId, table.idempotencyKey),
  index("idx_fin_report_export_jobs_org_status_created").on(table.orgId, table.status, table.createdAt),
  index("idx_fin_report_export_jobs_org_requester_created").on(table.orgId, table.requestedByMembershipId, table.createdAt),
  foreignKey({
    columns: [table.orgId, table.requestedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fin_report_export_jobs_org_requester_membership_fk",
  }).onDelete("set null"),
  check("chk_fin_report_export_jobs_status", sql`${table.status} IN ('pending','running','completed','failed','expired','cancelled')`),
  check("chk_fin_report_export_jobs_report_type", sql`${table.reportType} IN ('vendor_statement','customer_statement','sales_by_customer','sales_by_item','expense_by_category','tax_summary','project_profitability','department_profitability','budget_vs_actual')`),
  check("chk_fin_report_export_jobs_counts", sql`${table.processedRows} >= 0 AND (${table.rowCount} IS NULL OR ${table.rowCount} >= 0)`),
  check("chk_fin_report_export_jobs_attempts", sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10`),
]);
