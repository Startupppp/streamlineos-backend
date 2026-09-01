import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";

export type ExpenseExportJobStatus = "pending" | "running" | "completed" | "failed" | "expired";
export type ExpenseExportStatusFilter =
  | "DRAFT"
  | "SUBMITTED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "REIMBURSEMENT_PENDING"
  | "REIMBURSED"
  | "PAID";
export interface ExpenseExportFilters {
  status?: ExpenseExportStatusFilter;
  startDate?: string;
  endDate?: string;
  userId?: string;
  scope?: "all" | "own" | "team" | "none";
}

export const expenseExportJobs = pgTable("expense_export_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requestedByMembershipId: integer("requested_by_membership_id"),
  status: text("status").$type<ExpenseExportJobStatus>().notNull().default("pending"),
  filters: jsonb("filters").$type<ExpenseExportFilters>().notNull(),
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
  uniqueIndex("uniq_expense_export_jobs_org_idempotency").on(table.orgId, table.idempotencyKey),
  index("idx_expense_export_jobs_org_status_created").on(table.orgId, table.status, table.createdAt),
  index("idx_expense_export_jobs_org_requester_created").on(table.orgId, table.requestedByMembershipId, table.createdAt),
  foreignKey({
    columns: [table.orgId, table.requestedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "expense_export_jobs_org_requester_membership_fk",
  }).onDelete("set null"),
  check("chk_expense_export_jobs_status", sql`${table.status} IN ('pending','running','completed','failed','expired')`),
  check("chk_expense_export_jobs_counts", sql`${table.processedRows} >= 0 AND (${table.rowCount} IS NULL OR ${table.rowCount} >= 0)`),
  check("chk_expense_export_jobs_attempts", sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10`),
]);
