SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."idx_ai_jobs_correlation_id";
--> statement-breakpoint

ALTER TABLE "public"."ai_jobs" DROP COLUMN IF EXISTS "correlation_id";
