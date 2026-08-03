-- Rollback for 0381_dunning_attempts_table.sql
--
-- Drops the dunning_attempts table and all its indexes/constraints.
-- Run AFTER reverting 0382_dunning_attempts_backfill.sql (which moved data in)
-- and BEFORE reverting 0380_subscription_status_suspended.sql.
--
-- CAUTION: All dunning_attempts rows are permanently destroyed.
-- Back up the table first if any rows must be preserved.

DROP TABLE IF EXISTS dunning_attempts;
