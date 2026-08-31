SET lock_timeout = '5s';
--> statement-breakpoint
-- 0675: Composite FK constraints for the remaining chat membership-actor columns.
-- Columns were added and backfilled in 0660; FKs were omitted there.
-- Classification:
--   ATTRIBUTION  (pinned_by, started_by, sender, recipient) → ON DELETE SET NULL
--   AUTHORITY    (huddle_participant.membership, saved_message.membership) → ON DELETE CASCADE
--> statement-breakpoint
ALTER TABLE chat_pinned_messages
  ADD CONSTRAINT fk_chat_pinned_messages_org_pinner_membership
  FOREIGN KEY (org_id, pinned_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_huddles
  ADD CONSTRAINT fk_chat_huddles_org_starter_membership
  FOREIGN KEY (org_id, started_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_huddle_participants
  ADD CONSTRAINT fk_chat_huddle_participants_org_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_saved_messages
  ADD CONSTRAINT fk_chat_saved_messages_org_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_reply_reminders
  ADD CONSTRAINT fk_chat_reply_reminders_org_recipient_membership
  FOREIGN KEY (org_id, recipient_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_reply_reminders
  ADD CONSTRAINT fk_chat_reply_reminders_org_sender_membership
  FOREIGN KEY (org_id, sender_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_pinned_messages VALIDATE CONSTRAINT fk_chat_pinned_messages_org_pinner_membership;
--> statement-breakpoint
ALTER TABLE chat_huddles VALIDATE CONSTRAINT fk_chat_huddles_org_starter_membership;
--> statement-breakpoint
ALTER TABLE chat_huddle_participants VALIDATE CONSTRAINT fk_chat_huddle_participants_org_membership;
--> statement-breakpoint
ALTER TABLE chat_saved_messages VALIDATE CONSTRAINT fk_chat_saved_messages_org_membership;
--> statement-breakpoint
ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_recipient_membership;
--> statement-breakpoint
ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_sender_membership;
