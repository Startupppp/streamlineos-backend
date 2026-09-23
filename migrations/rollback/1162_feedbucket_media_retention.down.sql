-- Rollback for migration 1162.
--
-- Drops the media purge bookkeeping column and the index the sweep reads.
--
-- @data-loss: feedbucket_submissions.media_purged_at
-- The record of which submissions have already had their media purged is destroyed.
-- Re-applying 1162 afterwards leaves every previously purged row looking unpurged,
-- so the sweep will retry storage deletes that already happened. Those deletes are
-- idempotent, but the count it reports will be wrong.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_feedbucket_submissions_media_purge_due";
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions" DROP COLUMN IF EXISTS "media_purged_at";
