import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export type GdprExportJobStatus = "pending" | "running" | "completed" | "failed" | "expired";

export const gdprExportJobs = pgTable(
  "gdpr_export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectUserId: text("subject_user_id").notNull(),
    requestedBy: text("requested_by"),
    status: text("status").$type<GdprExportJobStatus>().notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    fileKey: text("file_key"),
    fileName: text("file_name"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
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
  },
  (table) => [
    uniqueIndex("uniq_gdpr_export_jobs_org_idempotency").on(table.orgId, table.idempotencyKey),
    index("idx_gdpr_export_jobs_org_status_created").on(table.orgId, table.status, table.createdAt),
    index("idx_gdpr_export_jobs_org_subject_created").on(table.orgId, table.subjectUserId, table.createdAt),
    check("chk_gdpr_export_jobs_status", sql`${table.status} IN ('pending','running','completed','failed','expired')`),
    check("chk_gdpr_export_jobs_attempts", sql`${table.attempt} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10`),
  ],
);
