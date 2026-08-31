-- Rollback for 0816_common_module_actor_drop
--
-- IRRECOVERABLE DATA LOSS WARNING:
-- Migration 0816 dropped created_by (users.id FK) from survey_versions after
-- the companion created_by_membership_id column was fully backfilled and
-- validated. The original user-id text values are permanently gone without a
-- point-in-time restore. This rollback recreates the column as nullable text
-- so the schema matches the pre-0816 shape. The FK constraint that was
-- dropped with the column is NOT recreated here.

SET lock_timeout = '5s';

-- survey_versions: restore created_by as nullable text
ALTER TABLE survey_versions
  ADD COLUMN IF NOT EXISTS created_by text;
