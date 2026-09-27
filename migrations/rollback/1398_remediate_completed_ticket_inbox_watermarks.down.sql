SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.inbox_records') IS NULL THEN
    RAISE EXCEPTION '1398-rollback precondition: public.inbox_records does not exist';
  END IF;
  IF to_regclass('public.outbox_events') IS NULL THEN
    RAISE EXCEPTION '1398-rollback precondition: public.outbox_events does not exist, the original versions cannot be restored';
  END IF;
END $$;
--> statement-breakpoint

UPDATE public.inbox_records i
SET aggregate_version = o.aggregate_version
FROM public.outbox_events o
WHERE o.event_id = i.producer_event_id
  AND i.aggregate_type = 'ticket'
  AND i.status = 'COMPLETED'
  AND i.aggregate_version = 0
  AND o.aggregate_version > 1000000000;
--> statement-breakpoint

DO $$
DECLARE
  restored bigint;
BEGIN
  SELECT count(*) INTO restored
  FROM public.inbox_records
  WHERE aggregate_type = 'ticket' AND status = 'COMPLETED' AND aggregate_version > 1000000000;
  ASSERT restored > 0,
    '1398-rollback post-check: no COMPLETED ticket row was restored to its epoch-scale version';
END $$;
