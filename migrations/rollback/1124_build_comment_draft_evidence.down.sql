-- Rollback for migration 1124.
--
-- The forward migration added seven nullable columns to build.comment_drafts:
-- evidence, proposed_change, impact, confidence, affected_record_ids, retry_count,
-- last_error. This rollback drops all seven. Any data stored in those columns is
-- permanently lost on apply.
--
-- No enum types were introduced; no dependency ordering is required beyond the
-- column drops themselves.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "evidence";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "proposed_change";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "impact";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "confidence";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "affected_record_ids";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "retry_count";
--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "last_error";
