import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  uniqueIndex,
  text,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const STORAGE_PURGE_BUCKETS = ["default", "kb"] as const;
export type StoragePurgeBucket = (typeof STORAGE_PURGE_BUCKETS)[number];

export const storagePendingPurge = pgTable(
  "storage_pending_purge",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    storageKey: text("storage_key").notNull(),
    purpose: text("purpose").notNull(),
    /**
     * Which bucket the object was written into, as a ROLE rather than a name:
     * bucket names differ per region and per deployment, and an unset
     * R2_KB_BUCKET_NAME legitimately resolves the `kb` role back onto the
     * default bucket, so a name recorded here would be wrong the moment either
     * changed. The producer writes it because the producer is the only party
     * that still knows.
     *
     * NULL means no producer recorded one — a row written before this column
     * existed. NULL is NOT a synonym for `default`, and a consumer must refuse
     * to delete on it rather than fall back to `purpose`: one purpose
     * (`org-purge`) spans a key from every table in the schema, KB tables
     * included, so it cannot resolve them all. Guessing is unsafe here in a way
     * it is nowhere else — an S3-compatible delete of an absent key answers
     * SUCCESS, so a delete addressed at the wrong bucket is indistinguishable
     * from a real one, and the confirmation that follows destroys the row that
     * was the last pointer to the surviving object.
     */
    bucket: text("bucket").$type<StoragePurgeBucket>(),
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
    check(
      "storage_pending_purge_bucket_check",
      sql`${table.bucket} IS NULL OR ${table.bucket} IN ('default', 'kb')`,
    ),
  ],
);
