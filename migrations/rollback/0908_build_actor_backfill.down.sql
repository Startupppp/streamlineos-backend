-- @data-loss
-- Backfill UPDATEs cannot be reversed without knowing which rows were NULL before.
-- The companion columns were added nullable in 0900 and remain nullable after this migration
-- reverts them. To revert, clear the companion columns:
--
-- NULL out all build companion columns populated by 0906.
-- This restores the pre-0906 state (all NULLs); the NOT VALID FKs from 0900 remain.

SET lock_timeout = '5s';

UPDATE "build"."projects" SET "manager_membership_id" = NULL, "client_membership_id" = NULL;
UPDATE "build"."comment_drafts" SET "membership_id" = NULL;
UPDATE "build"."okr_goals" SET "owner_membership_id" = NULL, "created_by_membership_id" = NULL;
UPDATE "build"."ticket_watchers" SET "membership_id" = NULL;
UPDATE "build"."ticket_checklist_items" SET "assignee_membership_id" = NULL;
UPDATE "build"."ticket_comment_reactions" SET "membership_id" = NULL;
UPDATE "build"."meeting_attendees" SET "membership_id" = NULL;
UPDATE "build"."meeting_standup_entries" SET "membership_id" = NULL;
UPDATE "build"."project_whiteboard_shares" SET "membership_id" = NULL;
UPDATE "build"."feedbucket_submissions" SET "assignee_membership_id" = NULL;
UPDATE "build"."project_team_members" SET "membership_id" = NULL;
UPDATE "build"."project_workspace_members" SET "membership_id" = NULL;
UPDATE "build"."bugs" SET "assignee_membership_id" = NULL, "qa_owner_membership_id" = NULL;
UPDATE "build"."test_runs" SET "tester_membership_id" = NULL;
UPDATE "build"."change_requests" SET "approval_owner_membership_id" = NULL;
