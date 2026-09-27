SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.inbox_records') IS NULL THEN
    RAISE EXCEPTION '1398 precondition: public.inbox_records does not exist';
  END IF;
  IF to_regclass('public.outbox_events') IS NULL THEN
    RAISE EXCEPTION '1398 precondition: public.outbox_events does not exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inbox_records
    WHERE aggregate_type = 'ticket'
      AND status = 'SKIPPED'
      AND aggregate_version > 1000000000
  ) THEN
    RAISE EXCEPTION '1398 precondition: epoch-scale SKIPPED ticket rows still present, apply 1374 first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inbox_records i
    WHERE i.aggregate_type = 'ticket'
      AND i.status = 'COMPLETED'
      AND i.aggregate_version > 1000000000
      AND NOT EXISTS (SELECT 1 FROM public.outbox_events o WHERE o.event_id = i.producer_event_id)
  ) THEN
    RAISE EXCEPTION '1398 precondition: an epoch-scale COMPLETED ticket row has no outbox_events row, so the rollback could not restore it';
  END IF;
END $$;
--> statement-breakpoint

UPDATE public.inbox_records
SET aggregate_version = 0
WHERE aggregate_type = 'ticket'
  AND status = 'COMPLETED'
  AND aggregate_version > 1000000000;
--> statement-breakpoint

DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM public.inbox_records
  WHERE aggregate_type = 'ticket' AND aggregate_version > 1000000000;
  ASSERT remaining = 0,
    format('1398 post-check: %s ticket inbox_records still carry an epoch-scale aggregate_version', remaining);
END $$;
