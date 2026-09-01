-- Rollback for 0137_add_voter_ip_hash
-- Reverses: +voter_ip_hash on roadmap_votes and feedback_votes,
--           +partial unique indexes uniq_roadmap_votes_item_ip and uniq_feedback_votes_post_ip
--
-- Migration 0432 moved roadmap_votes and feedback_votes from public to the build schema.
-- All table references and index qualifiers use build. accordingly.
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction.
-- Non-concurrent DROP INDEX is used here for transaction-safe verification.

SET lock_timeout = '5s';

-- 1. Drop the partial unique indexes first (depend on the columns).
DROP INDEX IF EXISTS "build"."uniq_roadmap_votes_item_ip";
DROP INDEX IF EXISTS "build"."uniq_feedback_votes_post_ip";

-- 2. Drop the columns.
ALTER TABLE "build"."roadmap_votes"   DROP COLUMN IF EXISTS "voter_ip_hash";
ALTER TABLE "build"."feedback_votes"  DROP COLUMN IF EXISTS "voter_ip_hash";
