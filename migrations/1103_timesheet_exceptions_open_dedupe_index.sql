-- 1103 — one OPEN exception per finding, again
-- =============================================================================
-- 0300 created `uniq_ts_exceptions_open_rule` on
--   (org_id, user_id, rule, COALESCE(period_id, -1), COALESCE(entry_id, -1))
--   WHERE status = 'OPEN'
-- so that `ExceptionsDetectorService` could re-run daily and insert each
-- finding once: its INSERT carries `ON CONFLICT DO NOTHING` and counts the rows
-- that landed.
--
-- 0824 dropped `timesheet_exceptions.user_id` for the membership actor cutover.
-- Dropping a column drops every index that includes it, and 0824 recreated the
-- plain (org_id, user_membership_id) index only — the partial UNIQUE was lost
-- without a word. From then on the detector's ON CONFLICT matched nothing, and
-- every cron tick and every "Run detection" inserted a fresh duplicate OPEN row
-- for every finding still open. Measured on this branch's cold database before
-- writing this: no unique index on the table besides the primary key.
--
-- The membership can be NULL for a finding whose worker no longer resolves, and
-- NULLs are distinct under a unique index, so it is COALESCEd like the other
-- two nullable members of the key.
--
-- Existing duplicates are collapsed first — the oldest row of each key stays,
-- since it is the one an operator may already have opened — because a unique
-- index cannot be built over them. Resolved and dismissed rows are outside the
-- predicate and untouched.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DELETE FROM "timesheet_exceptions" older
USING "timesheet_exceptions" newer
WHERE older."status" = 'OPEN'
  AND newer."status" = 'OPEN'
  AND older."org_id" = newer."org_id"
  AND older."rule" = newer."rule"
  AND COALESCE(older."user_membership_id", -1) = COALESCE(newer."user_membership_id", -1)
  AND COALESCE(older."period_id", -1) = COALESCE(newer."period_id", -1)
  AND COALESCE(older."entry_id", -1) = COALESCE(newer."entry_id", -1)
  AND older."id" > newer."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ts_exceptions_open_rule"
  ON "timesheet_exceptions" (
    "org_id",
    COALESCE("user_membership_id", -1),
    "rule",
    COALESCE("period_id", -1),
    COALESCE("entry_id", -1)
  )
  WHERE "status" = 'OPEN';
