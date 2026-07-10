CREATE INDEX IF NOT EXISTS "idx_notifications_inbox_keyset" ON "notifications" ("org_id","user_id","id" DESC) WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_unread_count" ON "notifications" ("org_id","user_id") WHERE "is_read" = false AND "deleted_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_rate_limit" ON "notification_deliveries" ("org_id","event_key","user_id","created_at") WHERE "status" IN ('SENT','DELIVERED','QUEUED','SENDING','PENDING');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_queue_locked" ON "notification_queue" ("status","locked_at") WHERE "status" = 'LOCKED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_queue_pending" ON "notification_queue" ("status","run_at") WHERE "status" IN ('PENDING','LOCKED');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_preferences_org_user" ON "notification_preferences" ("org_id","user_id");
