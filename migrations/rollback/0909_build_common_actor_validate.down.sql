-- Reverse 0907: re-mark all validated constraints as NOT VALID.
-- This removes the validation proof without dropping the constraint itself,
-- restoring the NOT VALID state that existed after 0900/0901 but before 0907.

SET lock_timeout = '5s';

ALTER TABLE "build"."projects" ALTER CONSTRAINT "fk_projects_manager_actor" NOT VALID;
ALTER TABLE "build"."projects" ALTER CONSTRAINT "fk_projects_client_actor" NOT VALID;
ALTER TABLE "build"."comment_drafts" ALTER CONSTRAINT "fk_comment_drafts_actor" NOT VALID;
ALTER TABLE "build"."okr_goals" ALTER CONSTRAINT "fk_okr_goals_owner_actor" NOT VALID;
ALTER TABLE "build"."okr_goals" ALTER CONSTRAINT "fk_okr_goals_created_by_actor" NOT VALID;
ALTER TABLE "build"."ticket_watchers" ALTER CONSTRAINT "fk_ticket_watchers_actor" NOT VALID;
ALTER TABLE "build"."ticket_checklist_items" ALTER CONSTRAINT "fk_ticket_checklist_items_assignee_actor" NOT VALID;
ALTER TABLE "build"."ticket_comment_reactions" ALTER CONSTRAINT "fk_ticket_comment_reactions_actor" NOT VALID;
ALTER TABLE "build"."meeting_attendees" ALTER CONSTRAINT "fk_meeting_attendees_actor" NOT VALID;
ALTER TABLE "build"."meeting_standup_entries" ALTER CONSTRAINT "fk_meeting_standup_entries_actor" NOT VALID;
ALTER TABLE "build"."project_whiteboard_shares" ALTER CONSTRAINT "fk_whiteboard_shares_actor" NOT VALID;
ALTER TABLE "build"."feedbucket_submissions" ALTER CONSTRAINT "fk_feedbucket_submissions_assignee_actor" NOT VALID;
ALTER TABLE "build"."project_team_members" ALTER CONSTRAINT "fk_project_team_members_actor" NOT VALID;
ALTER TABLE "build"."project_workspace_members" ALTER CONSTRAINT "fk_project_workspace_members_actor" NOT VALID;
ALTER TABLE "build"."bugs" ALTER CONSTRAINT "fk_bugs_assignee_actor" NOT VALID;
ALTER TABLE "build"."bugs" ALTER CONSTRAINT "fk_bugs_qa_owner_actor" NOT VALID;
ALTER TABLE "build"."test_runs" ALTER CONSTRAINT "fk_test_runs_tester_actor" NOT VALID;
ALTER TABLE "build"."change_requests" ALTER CONSTRAINT "fk_change_requests_approval_owner_actor" NOT VALID;
ALTER TABLE "notification_deliveries" ALTER CONSTRAINT "fk_notification_deliveries_actor" NOT VALID;
ALTER TABLE "notification_preference_rules" ALTER CONSTRAINT "fk_notification_pref_rules_actor" NOT VALID;
ALTER TABLE "notification_consents" ALTER CONSTRAINT "fk_notification_consents_actor" NOT VALID;
ALTER TABLE "notification_digest_items" ALTER CONSTRAINT "fk_notification_digest_items_actor" NOT VALID;
ALTER TABLE "broadcast_read_receipts" ALTER CONSTRAINT "fk_broadcast_read_receipts_actor" NOT VALID;
ALTER TABLE "notification_preferences" ALTER CONSTRAINT "fk_notification_preferences_actor" NOT VALID;
ALTER TABLE "push_subscriptions" ALTER CONSTRAINT "fk_push_subscriptions_actor" NOT VALID;
ALTER TABLE "onboarding_flow_sessions" ALTER CONSTRAINT "fk_onboarding_flow_sessions_actor" NOT VALID;
ALTER TABLE "user_tour_progress" ALTER CONSTRAINT "fk_user_tour_progress_actor" NOT VALID;
ALTER TABLE "user_integration_connections" ALTER CONSTRAINT "fk_user_integration_connections_actor" NOT VALID;
ALTER TABLE "coupon_redemptions" ALTER CONSTRAINT "fk_coupon_redemptions_actor" NOT VALID;
