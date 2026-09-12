-- Reverse 0909: return all 29 actor foreign keys to the NOT VALID state they were
-- created in by 0900 (build.*) and 0901 (common tables).
--
-- The inverse of VALIDATE CONSTRAINT is not ALTER CONSTRAINT. PostgreSQL's
-- ALTER TABLE ... ALTER CONSTRAINT can change deferrability and nothing else, so
-- `ALTER CONSTRAINT <fk> NOT VALID` is rejected with 0A000 "constraints cannot be
-- altered to be NOT VALID". A validated constraint can only be un-validated by
-- dropping it and adding it back NOT VALID, which is what this file does.
--
-- Each statement pairs the DROP with the ADD in one ALTER TABLE so the two run
-- under a single ACCESS EXCLUSIVE lock and the table is never left without its
-- foreign key. NOT VALID means the ADD does not re-scan the table, so this is a
-- catalog-only change: no rows are read, written or lost.
--
-- Every constraint definition below is the one 0900/0901 created, character for
-- character, including the PG15+ `ON DELETE SET NULL (<column>)` column lists that
-- null only the membership column and leave org_id in place. They are not derived
-- from the schema files. Statements appear in the same order as the VALIDATEs in
-- 0909 so the two files read against each other line by line.
--
-- Re-applying 0909 after this file re-validates all 29 in place.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "build"."projects"
  DROP CONSTRAINT "fk_projects_manager_actor",
  ADD CONSTRAINT "fk_projects_manager_actor" FOREIGN KEY ("org_id","manager_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("manager_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."projects"
  DROP CONSTRAINT "fk_projects_client_actor",
  ADD CONSTRAINT "fk_projects_client_actor" FOREIGN KEY ("org_id","client_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("client_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts"
  DROP CONSTRAINT "fk_comment_drafts_actor",
  ADD CONSTRAINT "fk_comment_drafts_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."okr_goals"
  DROP CONSTRAINT "fk_okr_goals_owner_actor",
  ADD CONSTRAINT "fk_okr_goals_owner_actor" FOREIGN KEY ("org_id","owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("owner_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."okr_goals"
  DROP CONSTRAINT "fk_okr_goals_created_by_actor",
  ADD CONSTRAINT "fk_okr_goals_created_by_actor" FOREIGN KEY ("org_id","created_by_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("created_by_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."ticket_watchers"
  DROP CONSTRAINT "fk_ticket_watchers_actor",
  ADD CONSTRAINT "fk_ticket_watchers_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."ticket_checklist_items"
  DROP CONSTRAINT "fk_ticket_checklist_items_assignee_actor",
  ADD CONSTRAINT "fk_ticket_checklist_items_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."ticket_comment_reactions"
  DROP CONSTRAINT "fk_ticket_comment_reactions_actor",
  ADD CONSTRAINT "fk_ticket_comment_reactions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."meeting_attendees"
  DROP CONSTRAINT "fk_meeting_attendees_actor",
  ADD CONSTRAINT "fk_meeting_attendees_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."meeting_standup_entries"
  DROP CONSTRAINT "fk_meeting_standup_entries_actor",
  ADD CONSTRAINT "fk_meeting_standup_entries_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."project_whiteboard_shares"
  DROP CONSTRAINT "fk_whiteboard_shares_actor",
  ADD CONSTRAINT "fk_whiteboard_shares_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions"
  DROP CONSTRAINT "fk_feedbucket_submissions_assignee_actor",
  ADD CONSTRAINT "fk_feedbucket_submissions_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."project_team_members"
  DROP CONSTRAINT "fk_project_team_members_actor",
  ADD CONSTRAINT "fk_project_team_members_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."project_workspace_members"
  DROP CONSTRAINT "fk_project_workspace_members_actor",
  ADD CONSTRAINT "fk_project_workspace_members_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."bugs"
  DROP CONSTRAINT "fk_bugs_assignee_actor",
  ADD CONSTRAINT "fk_bugs_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."bugs"
  DROP CONSTRAINT "fk_bugs_qa_owner_actor",
  ADD CONSTRAINT "fk_bugs_qa_owner_actor" FOREIGN KEY ("org_id","qa_owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("qa_owner_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."test_runs"
  DROP CONSTRAINT "fk_test_runs_tester_actor",
  ADD CONSTRAINT "fk_test_runs_tester_actor" FOREIGN KEY ("org_id","tester_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("tester_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "build"."change_requests"
  DROP CONSTRAINT "fk_change_requests_approval_owner_actor",
  ADD CONSTRAINT "fk_change_requests_approval_owner_actor" FOREIGN KEY ("org_id","approval_owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("approval_owner_membership_id") NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT "fk_notification_deliveries_actor",
  ADD CONSTRAINT "fk_notification_deliveries_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  DROP CONSTRAINT "fk_notification_pref_rules_actor",
  ADD CONSTRAINT "fk_notification_pref_rules_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_consents"
  DROP CONSTRAINT "fk_notification_consents_actor",
  ADD CONSTRAINT "fk_notification_consents_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  DROP CONSTRAINT "fk_notification_digest_items_actor",
  ADD CONSTRAINT "fk_notification_digest_items_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  DROP CONSTRAINT "fk_broadcast_read_receipts_actor",
  ADD CONSTRAINT "fk_broadcast_read_receipts_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_preferences"
  DROP CONSTRAINT "fk_notification_preferences_actor",
  ADD CONSTRAINT "fk_notification_preferences_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  DROP CONSTRAINT "fk_push_subscriptions_actor",
  ADD CONSTRAINT "fk_push_subscriptions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions"
  DROP CONSTRAINT "fk_onboarding_flow_sessions_actor",
  ADD CONSTRAINT "fk_onboarding_flow_sessions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "user_tour_progress"
  DROP CONSTRAINT "fk_user_tour_progress_actor",
  ADD CONSTRAINT "fk_user_tour_progress_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "user_integration_connections"
  DROP CONSTRAINT "fk_user_integration_connections_actor",
  ADD CONSTRAINT "fk_user_integration_connections_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "coupon_redemptions"
  DROP CONSTRAINT "fk_coupon_redemptions_actor",
  ADD CONSTRAINT "fk_coupon_redemptions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("membership_id") NOT VALID;
