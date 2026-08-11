-- Rollback for 0137_add_voter_ip_hash
-- Reverses: +voter_ip_hash on roadmap_votes and feedback_votes,
--           +partial unique indexes uniq_roadmap_votes_item_ip and uniq_feedback_votes_post_ip
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction.
-- Non-concurrent DROP INDEX is used here for transaction-safe verification.

SET lock_timeout = '5s';

-- 1. Drop the partial unique indexes first (depend on the columns).
DROP INDEX IF EXISTS "uniq_roadmap_votes_item_ip";
DROP INDEX IF EXISTS "uniq_feedback_votes_post_ip";

-- 2. Drop the columns.
ALTER TABLE "roadmap_votes"   DROP COLUMN IF EXISTS "voter_ip_hash";
ALTER TABLE "feedback_votes"  DROP COLUMN IF EXISTS "voter_ip_hash";
