-- Rollback for 0428. Drops the merge linkage; any merged posts simply become independent again.
-- Votes already moved to the canonical post are NOT split back out — that information is gone once
-- merged, which is inherent to merging and is why the service records merged_at.
DROP INDEX IF EXISTS "idx_feedback_posts_duplicate_of";
ALTER TABLE "feedback_posts" DROP COLUMN IF EXISTS "merged_at";
ALTER TABLE "feedback_posts" DROP COLUMN IF EXISTS "duplicate_of_id";
