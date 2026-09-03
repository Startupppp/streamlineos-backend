import {
  index,
  pgTable,
  uniqueIndex,
  text,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const storagePendingPurge = pgTable(
  "storage_pending_purge",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    storageKey: text("storage_key").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    failedReason: text("failed_reason"),
  },
  (table) => [
    uniqueIndex("uniq_storage_pending_purge_org_key").on(table.orgId, table.storageKey),
    index("idx_storage_pending_purge_retry").on(table.orgId, table.status, table.createdAt),
  ],
);
