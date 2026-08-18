import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export type HrExportJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "expired";

export type HrExportDataScope = "all" | "team" | "own" | "none";

export interface HrEmployeeExportFilters {
  search?: string;
  departmentId?: string;
  isActive?: "true" | "false" | "all";
  role?: string;
}

export const hrExportJobs = pgTable(
  "hr_export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    entity: text("entity").$type<"employees">().notNull(),
    status: text("status").$type<HrExportJobStatus>().default("pending").notNull(),
    filters: jsonb("filters").$type<HrEmployeeExportFilters>().notNull(),
    requestedScope: text("requested_scope").$type<HrExportDataScope>().notNull(),
    requestedBy: text("requested_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    fileKey: text("file_key"),
    fileName: text("file_name"),
    mimeType: text("mime_type").default("text/csv").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    processedRows: integer("processed_rows").default(0).notNull(),
    rowCount: integer("row_count"),
    attempt: integer("attempt").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_export_jobs_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_export_jobs_org_idempotency").on(
      table.orgId,
      table.idempotencyKey,
    ),
    index("idx_hr_export_jobs_org_status_created").on(
      table.orgId,
      table.status,
      table.createdAt,
    ),
    index("idx_hr_export_jobs_org_requester_created").on(
      table.orgId,
      table.requestedBy,
      table.createdAt,
    ),
    check(
      "chk_hr_export_jobs_status",
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'expired')`,
    ),
    check("chk_hr_export_jobs_scope", sql`${table.requestedScope} IN ('all', 'team', 'own', 'none')`),
    check("chk_hr_export_jobs_entity", sql`${table.entity} = 'employees'`),
    check(
      "chk_hr_export_jobs_attempts",
      sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10`,
    ),
    check(
      "chk_hr_export_jobs_counts",
      sql`${table.processedRows} >= 0 AND (${table.rowCount} IS NULL OR ${table.rowCount} >= 0)`,
    ),
  ],
);
