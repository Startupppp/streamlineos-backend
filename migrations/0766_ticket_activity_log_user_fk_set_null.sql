SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log
  DROP CONSTRAINT IF EXISTS fk_ticket_activity_log_user_actor;
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log
  ADD CONSTRAINT fk_ticket_activity_log_user_actor
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log
  VALIDATE CONSTRAINT fk_ticket_activity_log_user_actor;
