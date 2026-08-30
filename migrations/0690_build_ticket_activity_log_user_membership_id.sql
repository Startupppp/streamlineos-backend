SET lock_timeout = '5s';

ALTER TABLE build_events.ticket_activity_log
  ADD COLUMN IF NOT EXISTS user_membership_id integer;

UPDATE build_events.ticket_activity_log t
SET user_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.user_id
  AND om.org_id  = t.org_id
  AND t.user_id IS NOT NULL;

ALTER TABLE build_events.ticket_activity_log
  ADD CONSTRAINT fk_ticket_activity_log_user_actor
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
