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
  AND aggregate_version > 1000000000;
--> statement-breakpoint

DO $$
DECLARE
  stuck_count bigint;
BEGIN
  SELECT count(*) INTO stuck_count
  FROM public.inbox_records
  WHERE aggregate_type = 'ticket'
    AND aggregate_version > 1000000000;
  ASSERT stuck_count = 0,
    format('1374 post-check: %s inbox_record rows still carry timestamp-scale aggregate_version for aggregate_type=ticket', stuck_count);
END $$;
