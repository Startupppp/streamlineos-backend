-- Written but NOT applied. Requires `pnpm db:migrate` after review.
-- Adds per-event monotonic local_version to calendar_events so the provider-sync
-- sweep and webhook handler can detect stale provider echoes without relying on
-- timestamp comparison alone. Also adds event_local_version to the sync queue so
-- each job records the event version that triggered it, enabling superseded-job
-- cancellation for UPDATE operations.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "local_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "calendar_provider_sync_queue" ADD COLUMN "event_local_version" integer;
