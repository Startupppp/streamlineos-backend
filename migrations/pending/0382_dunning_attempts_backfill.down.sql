-- Rollback for 0382_dunning_attempts_backfill.sql
--
-- WHAT THIS CAN DO:
--   Delete all dunning_attempts rows that were inserted by the backfill
--   (identified by the subscription having a non-empty dunningAttempts JSONB array).
--   This is safe to run repeatedly (idempotent if dunning_attempts is already empty).
--
-- WHAT THIS CANNOT DO:
--   The original subscriptions.metadata JSONB was never modified by the forward
--   migration, so the source data is still intact — no data is lost by this rollback.
--   However, if the application wrote new dunning_attempts rows after the backfill
--   (i.e. from the new table-backed code path), those rows will ALSO be deleted by
--   the DELETE below if their subscription still has a dunningAttempts JSONB key.
--   Use the targeted DELETE variant if you need to preserve post-backfill rows:
--
--     DELETE FROM dunning_attempts da
--     USING subscriptions s
--     WHERE da.subscription_id = s.id
--       AND s.metadata ? 'dunningAttempts'
--       AND da.created_at < '<backfill_timestamp>';

DELETE FROM dunning_attempts da
USING subscriptions s
WHERE da.subscription_id = s.id
  AND s.metadata ? 'dunningAttempts';
