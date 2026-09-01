-- 0831: Change calendar_events.created_by_membership_id and
-- chat_channels.created_by_membership_id FKs from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- Both are creator-attribution columns. The event/channel record survives
-- after the creator leaves; only the membership pointer is cleared.
-- chat_channels already reflects SET NULL in the Drizzle schema (schema/DB drift
-- from missing migration) — this migration aligns the DB.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.calendar_events
  DROP CONSTRAINT IF EXISTS fk_calendar_events_org_creator_membership;
--> statement-breakpoint
ALTER TABLE public.calendar_events
  ADD CONSTRAINT fk_calendar_events_org_creator_membership
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.calendar_events
  VALIDATE CONSTRAINT fk_calendar_events_org_creator_membership;
--> statement-breakpoint

ALTER TABLE public.chat_channels
  DROP CONSTRAINT IF EXISTS fk_chat_channels_org_created_by_membership;
--> statement-breakpoint
ALTER TABLE public.chat_channels
  ADD CONSTRAINT fk_chat_channels_org_created_by_membership
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_channels
  VALIDATE CONSTRAINT fk_chat_channels_org_created_by_membership;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_calendar_events_org_creator_membership' AND c.contype = 'f'
    AND r.relname = 'calendar_events';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0831: fk_calendar_events_org_creator_membership confdeltype = % (expected n)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_chat_channels_org_created_by_membership' AND c.contype = 'f'
    AND r.relname = 'chat_channels';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0831: fk_chat_channels_org_created_by_membership confdeltype = % (expected n)', wrong_del;
  END IF;
END $$;
