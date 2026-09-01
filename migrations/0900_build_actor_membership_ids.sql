SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "manager_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "client_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "fk_projects_manager_actor" FOREIGN KEY ("org_id","manager_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("manager_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "fk_projects_client_actor" FOREIGN KEY ("org_id","client_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("client_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_org_manager_membership" ON "projects" ("org_id","manager_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_org_client_membership" ON "projects" ("org_id","client_membership_id");
--> statement-breakpoint
ALTER TABLE "comment_drafts" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "comment_drafts" ADD CONSTRAINT "fk_comment_drafts_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_comment_drafts_org_member_membership" ON "comment_drafts" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "okr_goals" ADD COLUMN IF NOT EXISTS "owner_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "okr_goals" ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "fk_okr_goals_owner_actor" FOREIGN KEY ("org_id","owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("owner_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "fk_okr_goals_created_by_actor" FOREIGN KEY ("org_id","created_by_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("created_by_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_okr_goals_org_owner_membership" ON "okr_goals" ("org_id","owner_membership_id");
--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "fk_ticket_watchers_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_watchers_org_membership" ON "ticket_watchers" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "fk_ticket_checklist_items_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_checklist_items_org_assignee_membership" ON "ticket_checklist_items" ("org_id","assignee_membership_id");
--> statement-breakpoint
ALTER TABLE "ticket_comment_reactions" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "ticket_comment_reactions" ADD CONSTRAINT "fk_ticket_comment_reactions_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_comment_reactions_org_membership" ON "ticket_comment_reactions" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "fk_meeting_attendees_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meeting_attendees_org_membership" ON "meeting_attendees" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "meeting_standup_entries" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "meeting_standup_entries" ADD CONSTRAINT "fk_meeting_standup_entries_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meeting_standup_entries_org_membership" ON "meeting_standup_entries" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "fk_whiteboard_shares_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whiteboard_shares_org_membership" ON "project_whiteboard_shares" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_org_assignee_membership" ON "feedbucket_submissions" ("org_id","assignee_membership_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE "project_team_members" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "project_team_members" ADD CONSTRAINT "fk_project_team_members_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_team_members_org_membership" ON "project_team_members" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "project_workspace_members" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "project_workspace_members" ADD CONSTRAINT "fk_project_workspace_members_actor" FOREIGN KEY ("org_id","membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_workspace_members_org_membership" ON "project_workspace_members" ("org_id","membership_id");
--> statement-breakpoint
ALTER TABLE "bugs" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "bugs" ADD COLUMN IF NOT EXISTS "qa_owner_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "fk_bugs_assignee_actor" FOREIGN KEY ("org_id","assignee_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("assignee_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "fk_bugs_qa_owner_actor" FOREIGN KEY ("org_id","qa_owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("qa_owner_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_assignee_membership" ON "bugs" ("org_id","assignee_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_qa_owner_membership" ON "bugs" ("org_id","qa_owner_membership_id");
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "tester_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "fk_test_runs_tester_actor" FOREIGN KEY ("org_id","tester_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("tester_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_org_tester_membership" ON "test_runs" ("org_id","tester_membership_id");
--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "approval_owner_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "fk_change_requests_approval_owner_actor" FOREIGN KEY ("org_id","approval_owner_membership_id") REFERENCES "public"."organization_members"("org_id","id") ON DELETE SET NULL ("approval_owner_membership_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_requests_org_approval_owner_membership" ON "change_requests" ("org_id","approval_owner_membership_id");
