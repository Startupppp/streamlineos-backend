-- 1374: reset ticket inbox watermarks recorded at timestamp scale, for SKIPPED rows only.
--
-- Two producers of the ticket status event disagreed on the version scale: one emitted the row's
-- integer `version`, the other emitted `Date.now()`. A consumer that recorded an epoch-scale
-- watermark then treated every subsequent row-scale event as older than what it had applied, and
-- skipped it. Those tickets stopped resuming.
--
-- Scope decision, owner-approved 2026-09-27. A production survey found 361 of 367 ticket rows at
-- epoch scale: 250 SKIPPED and 111 COMPLETED. Only the SKIPPED rows are reset. Resetting a
-- COMPLETED watermark would make an already-delivered ticket event eligible for reprocessing, and
-- ticket effects include assignee notification, so it would resend real notifications to real
-- people. Consumer deduplication on event identity is not proven, and a sent notification cannot be
-- recalled. The 111 COMPLETED rows are therefore left carrying an epoch-scale version deliberately:
-- they describe work already done, and nothing reads them again.
--
-- The post-check asserts the SKIPPED rows are clear, NOT that no epoch-scale ticket row remains --
-- because 111 of them are meant to remain.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.inbox_records') IS NULL THEN
    RAISE EXCEPTION '1374 precondition: public.inbox_records is absent';
  END IF;
END $$;
--> statement-breakpoint

UPDATE public.inbox_records
SET aggregate_version = 0
WHERE aggregate_type = 'ticket'
  AND aggregate_version > 1000000000
  AND status = 'SKIPPED';
--> statement-breakpoint

DO $$
DECLARE
  stuck_count bigint;
BEGIN
  SELECT count(*) INTO stuck_count
  FROM public.inbox_records
  WHERE aggregate_type = 'ticket'
    AND aggregate_version > 1000000000
    AND status = 'SKIPPED';
  ASSERT stuck_count = 0,
    format('1374 post-check: %s SKIPPED inbox_record rows still carry timestamp-scale aggregate_version for aggregate_type=ticket', stuck_count);
END $$;
