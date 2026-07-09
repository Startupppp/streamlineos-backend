-- Notifications cleanup + inbox read-path index.
-- Additive partial index for the hot inbox query; drops unused columns/table added in 0191.

CREATE INDEX IF NOT EXISTS "idx_notifications_inbox"
  ON "notifications" ("user_id", "org_id", "created_at")
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "idx_notifications_user_group";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "group_key";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "priority_preferences";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "digest_channel";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "digest_time";--> statement-breakpoint
DROP TABLE IF EXISTS "notification_digests";
