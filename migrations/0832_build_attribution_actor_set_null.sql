-- 0832: Change build-module attribution actor FKs from RESTRICT to SET NULL.
--
-- Tables: sprint_scope_events (build_events schema), ticket_related_links (build schema),
-- workflow_transitions (build schema).
--
-- Ruling: CHANGE TO SET NULL.
-- All three columns record who performed an action inside a Build artifact.
-- The artifact record survives after the actor leaves; only the membership
-- pointer is cleared. No parallel user column exists, so the UI should render
-- a placeholder (e.g. "Former member") when these are null.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE build_events.sprint_scope_events
  DROP CONSTRAINT IF EXISTS fk_sprint_scope_events_actor;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT fk_sprint_scope_events_actor
    FOREIGN KEY (org_id, actor_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (actor_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  VALIDATE CONSTRAINT fk_sprint_scope_events_actor;
--> statement-breakpoint

ALTER TABLE build.ticket_related_links
  DROP CONSTRAINT IF EXISTS fk_ticket_related_links_created_by_actor;
--> statement-breakpoint
ALTER TABLE build.ticket_related_links
  ADD CONSTRAINT fk_ticket_related_links_created_by_actor
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_related_links
  VALIDATE CONSTRAINT fk_ticket_related_links_created_by_actor;
--> statement-breakpoint

ALTER TABLE build.workflow_transitions
  DROP CONSTRAINT IF EXISTS fk_workflow_transitions_created_by_actor;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT fk_workflow_transitions_created_by_actor
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  VALIDATE CONSTRAINT fk_workflow_transitions_created_by_actor;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE c.conname = 'fk_sprint_scope_events_actor' AND c.contype = 'f'
    AND r.relname = 'sprint_scope_events' AND n.nspname = 'build_events';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0832: fk_sprint_scope_events_actor confdeltype = % (expected n)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE c.conname = 'fk_ticket_related_links_created_by_actor' AND c.contype = 'f'
    AND r.relname = 'ticket_related_links' AND n.nspname = 'build';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0832: fk_ticket_related_links_created_by_actor confdeltype = % (expected n)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE c.conname = 'fk_workflow_transitions_created_by_actor' AND c.contype = 'f'
    AND r.relname = 'workflow_transitions' AND n.nspname = 'build';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0832: fk_workflow_transitions_created_by_actor confdeltype = % (expected n)', wrong_del;
  END IF;
END $$;
