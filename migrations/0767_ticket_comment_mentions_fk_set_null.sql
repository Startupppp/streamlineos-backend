SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions
  DROP CONSTRAINT IF EXISTS fk_ticket_comment_mentions_mentioned_user_actor;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions
  ADD CONSTRAINT fk_ticket_comment_mentions_mentioned_user_actor
    FOREIGN KEY (org_id, mentioned_user_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (mentioned_user_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions
  VALIDATE CONSTRAINT fk_ticket_comment_mentions_mentioned_user_actor;
