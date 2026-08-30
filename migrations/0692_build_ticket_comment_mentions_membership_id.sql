SET lock_timeout = '5s';

ALTER TABLE build.ticket_comment_mentions
  ADD COLUMN IF NOT EXISTS mentioned_user_membership_id integer;

UPDATE build.ticket_comment_mentions t
SET mentioned_user_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.mentioned_user_id
  AND om.org_id  = t.org_id
  AND t.mentioned_user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ticket_comment_mentions_mentioned_user_actor'
  ) THEN
    ALTER TABLE build.ticket_comment_mentions
      ADD CONSTRAINT fk_ticket_comment_mentions_mentioned_user_actor
      FOREIGN KEY (org_id, mentioned_user_membership_id)
      REFERENCES public.organization_members (org_id, id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;
