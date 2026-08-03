-- Backfill dunning_attempts from subscriptions.metadata.dunningAttempts JSONB.
--
-- PRECONDITION: Migration 0381_dunning_attempts_table.sql must be applied first.
--
-- WHAT THIS DOES:
--   Reads every element of metadata->'dunningAttempts' from the subscriptions table
--   and inserts a row into dunning_attempts for each valid entry. Only elements with
--   a milestone value in the known set ('D+1','D+3','D+7','D+14') and a status in the
--   known set are inserted; unrecognised values are silently skipped.
--
--   period_start is approximated from current_period_start (falling back to created_at)
--   because the original JSONB array did not store a cycle identifier.
--
--   ON CONFLICT DO NOTHING makes this idempotent: re-running is safe.
--
-- WHAT THIS DOES NOT DO:
--   This migration does NOT remove the dunningAttempts key from metadata. Removing it
--   is a separate contract step that must happen only after:
--     (a) the application has been deployed and is no longer writing to metadata, and
--     (b) the backfilled rows have been validated in production.
--   When ready, run:
--     UPDATE subscriptions
--       SET metadata = metadata - 'dunningAttempts'
--       WHERE metadata ? 'dunningAttempts';
--
-- WHAT THIS DOES NOT DO (SUSPENDED status):
--   Subscriptions with metadata->>'suspendedForNonPayment' = 'true' and status =
--   'CANCELLED' are NOT automatically updated to 'SUSPENDED' here. That is a separate
--   data migration that requires the billing service to be updated and deployed first
--   so that the new reactivation semantics are in place before the status changes.
--
-- REVERSIBILITY: See .down.sql — rows can be deleted but the original JSONB is untouched.

SET statement_timeout = 0;

INSERT INTO dunning_attempts (
  org_id,
  subscription_id,
  period_start,
  milestone,
  status,
  outcome,
  notification_ref,
  attempted_at,
  created_at,
  updated_at
)
SELECT
  s.org_id,
  s.id                                                                AS subscription_id,
  COALESCE(s.current_period_start, s.created_at)                     AS period_start,
  attempt ->> 'milestone'                                             AS milestone,
  COALESCE(attempt ->> 'status', 'SENT')                             AS status,
  attempt ->> 'outcome'                                               AS outcome,
  attempt ->> 'notificationRef'                                       AS notification_ref,
  COALESCE(
    (attempt ->> 'attemptedAt')::timestamptz,
    s.created_at
  )                                                                   AS attempted_at,
  now()                                                               AS created_at,
  now()                                                               AS updated_at
FROM
  subscriptions s,
  jsonb_array_elements(s.metadata -> 'dunningAttempts') AS attempt
WHERE
  s.metadata ?  'dunningAttempts'
  AND jsonb_array_length(s.metadata -> 'dunningAttempts') > 0
  AND attempt ->> 'milestone' IN ('D+1', 'D+3', 'D+7', 'D+14')
  AND COALESCE(attempt ->> 'status', 'SENT') IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')
ON CONFLICT (org_id, subscription_id, period_start, milestone)
  DO NOTHING;
