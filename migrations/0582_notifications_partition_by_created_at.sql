-- c21-04: partition `notifications` by created_at. Notifications ONLY, as a proving ground.
--
-- DECISION (2026-08-27): of the three candidate tables this one has the smallest blast radius --
-- two inbound foreign keys rather than chat_messages' five, and no uniqueness guarantee that
-- partitioning would weaken. `chat_messages` and `notification_outbox` are deliberately NOT
-- partitioned here. The outbox in particular must not be: `uniq_notification_outbox_dedupe` on
-- (org_id, dedupe_key) is what stops a retried request enqueuing the same intent twice, and a
-- partitioned table can only enforce uniqueness per partition, so a retry crossing a month
-- boundary would enqueue twice.
--
-- Partitioning forces the partition key into every PK and UNIQUE, and Postgres only lets a foreign
-- key reference a unique constraint -- so both children must carry the parent's created_at and
-- reference the pair. That is what steps 1-3 do.
--
-- Partition names are {table}_y{YYYY}_m{MM}, which is what `expiredPartitions`
-- (notification-retention-policy.ts) generates and `NotificationRetentionService` detaches.
-- NOTE: this differs from the HRMS planner's `{table}_y{YYYY}m{MM}` (no underscore before m,
-- src/scripts/hrms-partition-planner/partition-sql.ts). Two conventions in one codebase is a trap;
-- this one follows the consumer that will actually detach these partitions. Whoever unifies them
-- owns both.
--
-- APPLIED AND VERIFIED 2026-08-31 against the dev database via pg_catalog:
--   notifications.relkind = 'p' (partitioned)
--   notification_deliveries_notification_fk = FOREIGN KEY (notification_id, notification_created_at)
--     REFERENCES notifications(id, created_at) ON DELETE CASCADE, convalidated = true
--   per-partition FKs present through notifications_default; notifications_default holds 0 rows.
--
-- OPERATOR, after applying:
--     VACUUM ANALYZE notifications, notification_deliveries, notification_audit_logs;
-- The copy rewrites every row and the two children get a new column, which invalidates planner
-- statistics and empties the visibility map. One table here went 53 -> 201,875 blocks for skipping
-- it, and a count stayed wrong until VACUUM specifically.

SET lock_timeout = '5s';
SET statement_timeout = 0;

--> statement-breakpoint
ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "notification_created_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "notification_audit_logs"
  ADD COLUMN IF NOT EXISTS "notification_created_at" timestamptz;

--> statement-breakpoint
UPDATE "notification_deliveries" d
SET "notification_created_at" = n."created_at"
FROM "notifications" n
WHERE d."notification_id" = n."id"
  AND d."notification_created_at" IS NULL;
--> statement-breakpoint
UPDATE "notification_audit_logs" a
SET "notification_created_at" = n."created_at"
FROM "notifications" n
WHERE a."notification_id" = n."id"
  AND a."notification_created_at" IS NULL;

--> statement-breakpoint
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS child, conname
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'notifications'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.child, c.conname);
  END LOOP;
END $$;

--> statement-breakpoint
ALTER TABLE "notifications" RENAME TO "notifications_unpartitioned";

--> statement-breakpoint
CREATE TABLE "notifications" (
  LIKE "notifications_unpartitioned"
    INCLUDING DEFAULTS
    INCLUDING IDENTITY
    INCLUDING STORAGE
    INCLUDING COMMENTS
) PARTITION BY RANGE ("created_at");

--> statement-breakpoint
DO $$
DECLARE
  start_month date := date '2024-01-01';
  end_month   date := date '2028-01-01';
  cur         date;
BEGIN
  cur := start_month;
  WHILE cur < end_month LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "notifications" FOR VALUES FROM (%L) TO (%L)',
      format('notifications_y%s_m%s', to_char(cur, 'YYYY'), to_char(cur, 'MM')),
      cur,
      cur + interval '1 month'
    );
    cur := cur + interval '1 month';
  END LOOP;
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications_default" PARTITION OF "notifications" DEFAULT;

--> statement-breakpoint
INSERT INTO "notifications" OVERRIDING SYSTEM VALUE
SELECT * FROM "notifications_unpartitioned";

--> statement-breakpoint
DROP TABLE "notifications_unpartitioned";

--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id", "created_at");
--> statement-breakpoint
ALTER TABLE "notifications"
  ADD CONSTRAINT "uniq_notifications_org_id" UNIQUE ("org_id", "id", "created_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_list_cursor"
  ON "notifications" ("org_id", "user_id", "id" DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_unread_count"
  ON "notifications" ("org_id", "user_id", "id")
  WHERE deleted_at IS NULL AND archived_at IS NULL AND is_read = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_org_created"
  ON "notifications" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_archived"
  ON "notifications" ("user_id", "archived_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_org_category"
  ON "notifications" ("org_id", "category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_dedupe"
  ON "notifications" ("org_id", "event_key", "entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_org_user_active"
  ON "notifications" ("org_id", "user_id", "id")
  WHERE deleted_at IS NULL;

--> statement-breakpoint
SELECT setval(
  pg_get_serial_sequence('notifications', 'id'),
  GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "notifications"), 1)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_parent"
  ON "notification_deliveries" ("notification_id", "notification_created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_audit_logs_parent"
  ON "notification_audit_logs" ("notification_id", "notification_created_at");

--> statement-breakpoint
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_notification_fk"
  FOREIGN KEY ("notification_id", "notification_created_at")
  REFERENCES "notifications" ("id", "created_at")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_deliveries"
  VALIDATE CONSTRAINT "notification_deliveries_notification_fk";

--> statement-breakpoint
ALTER TABLE "notification_audit_logs"
  ADD CONSTRAINT "notification_audit_logs_notification_fk"
  FOREIGN KEY ("notification_id", "notification_created_at")
  REFERENCES "notifications" ("id", "created_at")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "notification_audit_logs"
  VALIDATE CONSTRAINT "notification_audit_logs_notification_fk";

-- VERIFY (run as owner; every row must be true):
--
--   SELECT 'partitioned' AS check,
--          (SELECT relkind FROM pg_class WHERE relname = 'notifications') = 'p'
--   UNION ALL SELECT 'partition count >= 48',
--          (SELECT count(*) FROM pg_inherits WHERE inhparent = 'notifications'::regclass) >= 48
--   UNION ALL SELECT 'default partition empty',
--          NOT EXISTS (SELECT 1 FROM notifications_default)
--   UNION ALL SELECT 'deliveries fk valid',
--          (SELECT convalidated FROM pg_constraint
--            WHERE conname = 'notification_deliveries_notification_fk')
--   UNION ALL SELECT 'audit fk valid',
--          (SELECT convalidated FROM pg_constraint
--            WHERE conname = 'notification_audit_logs_notification_fk')
--   UNION ALL SELECT 'no orphaned delivery timestamps',
--          NOT EXISTS (SELECT 1 FROM notification_deliveries
--                      WHERE notification_id IS NOT NULL AND notification_created_at IS NULL);
--
-- A non-empty notifications_default means a row fell outside 2024-01..2027-12 and the partition
-- range needs extending before that month arrives.
