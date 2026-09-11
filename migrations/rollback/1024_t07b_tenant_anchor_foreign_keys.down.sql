-- 1024 DOWN -- drops the three tenant anchors, restoring the state where
-- `notifications.org_id`, `chat_message_reactions.org_id` and
-- `build.project_ticket_counters.org_id` are declared but unconstrained. Reverting
-- fk_notifications_org restores the orphan: a notification with a NULL membership_id
-- survives DELETE FROM organizations again.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS fk_notifications_org;
--> statement-breakpoint

ALTER TABLE build.project_ticket_counters DROP CONSTRAINT IF EXISTS fk_project_ticket_counters_org;
--> statement-breakpoint

ALTER TABLE chat_message_reactions DROP CONSTRAINT IF EXISTS fk_chat_message_reactions_org;
