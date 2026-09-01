-- Rollback 0900: drop the membership-id columns added to Build module tables.
--
-- @data-loss — the membership-id pointers (manager_membership_id, client_membership_id,
-- membership_id, owner_membership_id, created_by_membership_id, assignee_membership_id,
-- qa_owner_membership_id, tester_membership_id, approval_owner_membership_id) are discarded
-- across all affected tables. This is acceptable: the legacy user-id columns are still
-- present and still populated, so all tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.
--
-- All tables were moved to the `build` schema by 0432_build_schema; every ALTER TABLE
-- uses the fully-qualified `build.<table>` form.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "build"."projects" DROP CONSTRAINT IF EXISTS "fk_projects_manager_actor";

--> statement-breakpoint
ALTER TABLE "build"."projects" DROP CONSTRAINT IF EXISTS "fk_projects_client_actor";

--> statement-breakpoint
ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "manager_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "client_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP CONSTRAINT IF EXISTS "fk_comment_drafts_actor";

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" DROP CONSTRAINT IF EXISTS "fk_okr_goals_owner_actor";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" DROP CONSTRAINT IF EXISTS "fk_okr_goals_created_by_actor";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" DROP COLUMN IF EXISTS "owner_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."okr_goals" DROP COLUMN IF EXISTS "created_by_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."ticket_watchers" DROP CONSTRAINT IF EXISTS "fk_ticket_watchers_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_watchers" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."ticket_checklist_items" DROP CONSTRAINT IF EXISTS "fk_ticket_checklist_items_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_checklist_items" DROP COLUMN IF EXISTS "assignee_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."ticket_comment_reactions" DROP CONSTRAINT IF EXISTS "fk_ticket_comment_reactions_actor";

--> statement-breakpoint
ALTER TABLE "build"."ticket_comment_reactions" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."meeting_attendees" DROP CONSTRAINT IF EXISTS "fk_meeting_attendees_actor";

--> statement-breakpoint
ALTER TABLE "build"."meeting_attendees" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."meeting_standup_entries" DROP CONSTRAINT IF EXISTS "fk_meeting_standup_entries_actor";

--> statement-breakpoint
ALTER TABLE "build"."meeting_standup_entries" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."project_whiteboard_shares" DROP CONSTRAINT IF EXISTS "fk_whiteboard_shares_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_whiteboard_shares" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP CONSTRAINT IF EXISTS "fk_feedbucket_submissions_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" DROP COLUMN IF EXISTS "assignee_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."project_team_members" DROP CONSTRAINT IF EXISTS "fk_project_team_members_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_team_members" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."project_workspace_members" DROP CONSTRAINT IF EXISTS "fk_project_workspace_members_actor";

--> statement-breakpoint
ALTER TABLE "build"."project_workspace_members" DROP COLUMN IF EXISTS "membership_id";

--> statement-breakpoint
ALTER TABLE "build"."bugs" DROP CONSTRAINT IF EXISTS "fk_bugs_assignee_actor";

--> statement-breakpoint
ALTER TABLE "build"."bugs" DROP CONSTRAINT IF EXISTS "fk_bugs_qa_owner_actor";

--> statement-breakpoint
ALTER TABLE "build"."bugs" DROP COLUMN IF EXISTS "assignee_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."bugs" DROP COLUMN IF EXISTS "qa_owner_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_tester_actor";

--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP COLUMN IF EXISTS "tester_membership_id";

--> statement-breakpoint
ALTER TABLE "build"."change_requests" DROP CONSTRAINT IF EXISTS "fk_change_requests_approval_owner_actor";

--> statement-breakpoint
ALTER TABLE "build"."change_requests" DROP COLUMN IF EXISTS "approval_owner_membership_id";
