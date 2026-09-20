SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "evidence" text;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "proposed_change" text;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "impact" text;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "confidence" integer;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "affected_record_ids" text;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "retry_count" integer;
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD COLUMN IF NOT EXISTS "last_error" text;
