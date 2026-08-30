SET lock_timeout = '5s';

ALTER TABLE build_events.sprint_scope_events
  ADD COLUMN IF NOT EXISTS actor_membership_id integer;

UPDATE build_events.sprint_scope_events t
SET actor_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.actor_id
  AND om.org_id  = t.org_id
  AND t.actor_id IS NOT NULL;

ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT fk_sprint_scope_events_actor
  FOREIGN KEY (org_id, actor_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
