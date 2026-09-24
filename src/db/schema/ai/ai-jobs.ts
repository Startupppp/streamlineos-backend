import { pgTable, pgEnum, serial, text, varchar, integer, jsonb, timestamp, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";

export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "QUEUED", "RUNNING", "COMPLETED", "FAILED", "DEAD", "CANCELLED",
]);

export const aiJobs = pgTable("ai_jobs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  userMembershipId: integer("user_membership_id"),
  type: varchar("type", { length: 100 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: aiJobStatusEnum("status").default("QUEUED").notNull(),
  priority: integer("priority").default(0).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 120 }),
  correlationId: varchar("correlation_id", { length: 128 }),
  runAt: timestamp("run_at").defaultNow().notNull(),
  lockedBy: varchar("locked_by", { length: 64 }),
  lockedAt: timestamp("locked_at"),
  lastError: text("last_error"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_ai_jobs_org_idem_key").on(table.orgId, table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL`),
  index("idx_ai_jobs_status_run_at_priority").on(table.status, table.runAt, table.priority),
  index("idx_ai_jobs_expired_lease").on(table.lockedAt).where(sql`status = 'RUNNING'`),
  index("idx_ai_jobs_org_created_at").on(table.orgId, table.createdAt),
  index("idx_ai_jobs_org_type_status").on(table.orgId, table.type, table.status),
  index("idx_ai_jobs_correlation_id").on(table.correlationId).where(sql`${table.correlationId} IS NOT NULL`),
  unique("uniq_ai_jobs_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_ai_jobs_org_user_mbr",
  }).onDelete("set null"),
]);

export type AiJob = typeof aiJobs.$inferSelect;
