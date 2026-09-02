-- 0934_ar05_calendar_provider_sync_queue DOWN — drops the provider sync queue table and its indexes.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cal_provider_sync_queue_pending";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cal_provider_sync_queue_org";
--> statement-breakpoint
DROP TABLE IF EXISTS "calendar_provider_sync_queue";
