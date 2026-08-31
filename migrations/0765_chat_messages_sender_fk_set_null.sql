SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.chat_messages
  DROP CONSTRAINT IF EXISTS fk_chat_messages_org_sender_membership;
--> statement-breakpoint
ALTER TABLE public.chat_messages
  ADD CONSTRAINT fk_chat_messages_org_sender_membership
    FOREIGN KEY (org_id, sender_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (sender_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_messages
  VALIDATE CONSTRAINT fk_chat_messages_org_sender_membership;
