SET lock_timeout = '5s';

ALTER TABLE build.ticket_related_links
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer;

UPDATE build.ticket_related_links t
SET created_by_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.created_by
  AND om.org_id  = t.org_id
  AND t.created_by IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_related_links_created_by_actor'
  ) THEN
    ALTER TABLE build.ticket_related_links
      ADD CONSTRAINT fk_ticket_related_links_created_by_actor
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES public.organization_members (org_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;
