-- 0418: four index/constraint defects from the Phase 0 audit.
--
-- SCH-015  notification_queue.delivery_id had no unique index, so a retried
--          persistForUser could enqueue two jobs for one delivery. The code already
--          guarantees at most one (the worker updates an existing row and only
--          inserts when none exists), so this makes the invariant the database's
--          rather than the caller's.
--
-- SCH-007  idx_notifications_user_unread_created is (user_id, is_read, created_at) —
--          not org-led (§19), and it backs the most-executed query in the product.
--          Replaced with an org-led partial index matching the actual predicate,
--          which also excludes archived rows the old one scanned.
--
-- SCH-008  idx_notifications_priority is a single-column index on a 4-value enum.
--          Never selective enough to be chosen; pure write cost.
--
-- SCH-005  push_subscriptions had only created_at, so a stale subscription had no
--          signal other than a 410 from the push service.
--
-- DELIBERATELY NOT DONE — SCH-006. The audit proposed replacing the bare global
-- UNIQUE (endpoint) with (org_id, user_id, endpoint). That is wrong: a Web Push
-- endpoint identifies a *browser*, not a user. The global unique is what stops two
-- accounts registering the same device; a composite would let both keep a row and
-- every notification for either user would be delivered to that one device. The
-- existing constraint is correct and stays.

SET lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_queue_delivery"
  ON "notification_queue" ("delivery_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_notifications_org_user_unread"
  ON "notifications" ("org_id", "user_id", "is_read", "created_at" DESC)
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_notifications_user_unread_created";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_notifications_priority";
--> statement-breakpoint

ALTER TABLE "push_subscriptions"
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "push_subscriptions"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
