SET lock_timeout = '5s';

ALTER TABLE build.workflow_transitions
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer;

UPDATE build.workflow_transitions t
SET created_by_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.created_by
  AND om.org_id  = t.org_id
  AND t.created_by IS NOT NULL;

ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT fk_workflow_transitions_created_by_actor
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
