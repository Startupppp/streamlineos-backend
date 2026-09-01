-- 0907: VALIDATE all NOT VALID FK constraints added by migrations 0900 and 0901.
--
-- NOT VALID skips the full-table scan on constraint creation; VALIDATE checks existing rows
-- after the backfill (0906 for build tables) has run. Each VALIDATE acquires
-- SHARE UPDATE EXCLUSIVE, which allows concurrent reads and DML, unlike the ACCESS EXCLUSIVE
-- held during the original ADD CONSTRAINT.
--
-- Build tables validated here (from 0900):
--   projects (manager_actor, client_actor)
--   comment_drafts
--   okr_goals (owner_actor, created_by_actor)
--   ticket_watchers
--   ticket_checklist_items
--   ticket_comment_reactions
--   meeting_attendees
--   meeting_standup_entries
--   project_whiteboard_shares
--   feedbucket_submissions (assignee_actor)
--   project_team_members
--   project_workspace_members
--   bugs (assignee_actor, qa_owner_actor)
--   test_runs (tester_actor)
--   change_requests (approval_owner_actor)
--
-- Common tables validated here (from 0901):
--   notification_deliveries
--   notification_preference_rules
--   notification_consents
--   notification_digest_items
--   broadcast_read_receipts
--   notification_preferences
--   push_subscriptions
--   onboarding_flow_sessions
--   user_tour_progress
--   user_integration_connections
--   coupon_redemptions

SET lock_timeout = '60s';

--> statement-breakpoint
ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "fk_projects_manager_actor";

--> statement-breakpoint
ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "fk_projects_client_actor";

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" VALIDATE CONSTRAINT "fk_comment_drafts_actor";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" VALIDATE CONSTRAINT "fk_okr_goals_owner_actor";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" VALIDATE CONSTRAINT "fk_okr_goals_created_by_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_watchers" VALIDATE CONSTRAINT "fk_ticket_watchers_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_checklist_items" VALIDATE CONSTRAINT "fk_ticket_checklist_items_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_comment_reactions" VALIDATE CONSTRAINT "fk_ticket_comment_reactions_actor";

--> statement-breakpoint
ALTER TABLE "build"."meeting_attendees" VALIDATE CONSTRAINT "fk_meeting_attendees_actor";

--> statement-breakpoint
ALTER TABLE "build"."meeting_standup_entries" VALIDATE CONSTRAINT "fk_meeting_standup_entries_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_whiteboard_shares" VALIDATE CONSTRAINT "fk_whiteboard_shares_actor";

--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" VALIDATE CONSTRAINT "fk_feedbucket_submissions_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_team_members" VALIDATE CONSTRAINT "fk_project_team_members_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_workspace_members" VALIDATE CONSTRAINT "fk_project_workspace_members_actor";

--> statement-breakpoint
ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."bugs" VALIDATE CONSTRAINT "fk_bugs_qa_owner_actor";

--> statement-breakpoint
ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_tester_actor";

--> statement-breakpoint
ALTER TABLE "build"."change_requests" VALIDATE CONSTRAINT "fk_change_requests_approval_owner_actor";

--> statement-breakpoint
ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "fk_notification_deliveries_actor";

--> statement-breakpoint
ALTER TABLE "notification_preference_rules" VALIDATE CONSTRAINT "fk_notification_pref_rules_actor";

--> statement-breakpoint
ALTER TABLE "notification_consents" VALIDATE CONSTRAINT "fk_notification_consents_actor";

--> statement-breakpoint
ALTER TABLE "notification_digest_items" VALIDATE CONSTRAINT "fk_notification_digest_items_actor";

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts" VALIDATE CONSTRAINT "fk_broadcast_read_receipts_actor";

--> statement-breakpoint
ALTER TABLE "notification_preferences" VALIDATE CONSTRAINT "fk_notification_preferences_actor";

--> statement-breakpoint
ALTER TABLE "push_subscriptions" VALIDATE CONSTRAINT "fk_push_subscriptions_actor";

--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" VALIDATE CONSTRAINT "fk_onboarding_flow_sessions_actor";

--> statement-breakpoint
ALTER TABLE "user_tour_progress" VALIDATE CONSTRAINT "fk_user_tour_progress_actor";

--> statement-breakpoint
ALTER TABLE "user_integration_connections" VALIDATE CONSTRAINT "fk_user_integration_connections_actor";

--> statement-breakpoint
ALTER TABLE "coupon_redemptions" VALIDATE CONSTRAINT "fk_coupon_redemptions_actor";
