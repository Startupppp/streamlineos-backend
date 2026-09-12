-- Reverses 1103's index. The duplicate OPEN rows 1103 collapsed are not
-- restored — they were the defect, and each one that stays is the row an
-- operator may already have opened. Dropping the index re-opens the
-- duplication the detector's ON CONFLICT DO NOTHING relies on it to prevent.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_ts_exceptions_open_rule";
