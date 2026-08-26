-- 0491 — migrate dunning attempts from subscriptions.metadata JSONB to dunning_attempts table
-- =============================================================================
-- Ticket: c17-06 (dunning history is queryable)
--
-- The cron-billing service has been writing dunning attempt numbers into a JSONB
-- array (metadata.dunningAttempts) instead of the dunning_attempts table that
-- was created in 0423 for exactly this purpose. This migration backfills rows
-- for any PAST_DUE subscriptions that have entries in that array so no history
-- is lost, then the service is updated to write to the table going forward.
--
-- The milestone format in dunning_attempts is 'D+1', 'D+3', 'D+7', 'D+14'.
-- The JSONB array contains the raw day integers: [1, 3, 7, 14].
-- pastDueAt is stored as an ISO-8601 string in metadata.pastDueAt.
--
-- Safe to run online: inserts with ON CONFLICT DO NOTHING; no table locks needed.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO dunning_attempts (
  org_id,
  subscription_id,
  period_start,
  milestone,
  status,
  outcome,
  attempted_at,
  created_at,
  updated_at
)
SELECT
  s.org_id,
  s.id AS subscription_id,
  (s.metadata ->> 'pastDueAt')::timestamptz AS period_start,
  'D+' || attempt_day AS milestone,
  'SENT' AS status,
  NULL AS outcome,
  (s.metadata ->> 'pastDueAt')::timestamptz
    + (attempt_day::int * interval '1 day') AS attempted_at,
  now() AS created_at,
  now() AS updated_at
FROM
  subscriptions s,
  jsonb_array_elements_text(
    COALESCE(s.metadata -> 'dunningAttempts', '[]'::jsonb)
  ) AS t(attempt_day)
WHERE
  s.metadata ? 'dunningAttempts'
  AND jsonb_array_length(COALESCE(s.metadata -> 'dunningAttempts', '[]'::jsonb)) > 0
  AND (s.metadata ->> 'pastDueAt') IS NOT NULL
  AND attempt_day IN ('1', '3', '7', '14')
ON CONFLICT (org_id, subscription_id, period_start, milestone) DO NOTHING;
