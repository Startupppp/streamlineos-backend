-- 0917: Contract Build authority references from global users to org memberships.
-- The companion columns were expanded in 0900, backfilled in 0908, and validated in 0909.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'build' AND table_name = 'project_members' AND column_name = 'user_id') THEN
    UPDATE "build"."project_members" pm
    SET "membership_id" = om.id
    FROM "public"."organization_members" om
    WHERE om.org_id = pm.org_id AND om.user_id = pm.user_id AND pm.membership_id IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'build' AND table_name = 'ticket_assignees' AND column_name = 'user_id') THEN
    UPDATE "build"."ticket_assignees" ta
    SET "membership_id" = om.id
    FROM "public"."organization_members" om
    WHERE om.org_id = ta.org_id AND om.user_id = ta.user_id AND ta.membership_id IS NULL;
  END IF;
END $$;

--> statement-breakpoint
DO $$
DECLARE orphan_count bigint;
BEGIN
  SELECT (SELECT count(*) FROM "build"."project_members" WHERE membership_id IS NULL) +
         (SELECT count(*) FROM "build"."ticket_assignees" WHERE membership_id IS NULL)
    INTO orphan_count;
  IF orphan_count > 0 THEN
    RAISE NOTICE '0917 unmappable Build actor rows=%; removing orphan assignments with no legacy identity', orphan_count;
    DELETE FROM "build"."project_members" WHERE membership_id IS NULL;
    DELETE FROM "build"."ticket_assignees" WHERE membership_id IS NULL;
  END IF;
END $$;

--> statement-breakpoint
DO $$
DECLARE
  unmappable_count integer;
BEGIN
  SELECT
    (SELECT count(*) FROM "build"."comment_drafts" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."meeting_attendees" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."project_members" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."project_team_members" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."project_workspace_members" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."project_whiteboard_shares" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."ticket_assignees" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."ticket_comment_reactions" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "build"."ticket_watchers" WHERE "membership_id" IS NULL)
  INTO unmappable_count;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0917 blocked: % required Build actor row(s) cannot map to an organization membership', unmappable_count;
  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "build"."uniq_comment_drafts_owner_ticket";
DROP INDEX IF EXISTS "build"."idx_comment_drafts_org_user";
DROP INDEX IF EXISTS "build"."uq_meeting_attendees_meeting_user";
DROP INDEX IF EXISTS "build"."idx_meeting_attendees_user";
DROP INDEX IF EXISTS "build"."uniq_project_members_project_user";
DROP INDEX IF EXISTS "build"."idx_project_members_user";
DROP INDEX IF EXISTS "build"."idx_project_members_org_user";
DROP INDEX IF EXISTS "build"."uniq_project_team_members_team_user";
DROP INDEX IF EXISTS "build"."idx_project_team_members_user";
DROP INDEX IF EXISTS "build"."uniq_project_workspace_members_org_user";
DROP INDEX IF EXISTS "build"."uniq_whiteboard_shares_board_user";
DROP INDEX IF EXISTS "build"."uniq_ticket_assignees_ticket_user";
DROP INDEX IF EXISTS "build"."idx_ticket_assignees_user_id";
DROP INDEX IF EXISTS "build"."idx_ticket_assignees_org_user_ticket";
DROP INDEX IF EXISTS "build"."uniq_ticket_watcher";
DROP INDEX IF EXISTS "build"."idx_ticket_watchers_user";
DROP INDEX IF EXISTS "build"."uq_comment_reaction_user_emoji";
DROP INDEX IF EXISTS "build"."idx_projects_manager";
DROP INDEX IF EXISTS "build"."idx_tickets_org_assignee_status";
DROP INDEX IF EXISTS "build"."idx_tickets_org_assignee_due_open";
DROP INDEX IF EXISTS "build"."idx_project_approvals_approver_status";
DROP INDEX IF EXISTS "build"."idx_feedbucket_submissions_assignee";
DROP INDEX IF EXISTS "build"."idx_bugs_assignee";

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ADD CONSTRAINT "ck_0917_comment_drafts_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."comment_drafts" VALIDATE CONSTRAINT "ck_0917_comment_drafts_membership";
ALTER TABLE "build"."meeting_attendees" ADD CONSTRAINT "ck_0917_meeting_attendees_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."meeting_attendees" VALIDATE CONSTRAINT "ck_0917_meeting_attendees_membership";
ALTER TABLE "build"."project_members" ADD CONSTRAINT "ck_0917_project_members_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."project_members" VALIDATE CONSTRAINT "ck_0917_project_members_membership";
ALTER TABLE "build"."project_team_members" ADD CONSTRAINT "ck_0917_project_team_members_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."project_team_members" VALIDATE CONSTRAINT "ck_0917_project_team_members_membership";
ALTER TABLE "build"."project_workspace_members" ADD CONSTRAINT "ck_0917_project_workspace_members_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."project_workspace_members" VALIDATE CONSTRAINT "ck_0917_project_workspace_members_membership";
ALTER TABLE "build"."project_whiteboard_shares" ADD CONSTRAINT "ck_0917_project_whiteboard_shares_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."project_whiteboard_shares" VALIDATE CONSTRAINT "ck_0917_project_whiteboard_shares_membership";
ALTER TABLE "build"."ticket_assignees" ADD CONSTRAINT "ck_0917_ticket_assignees_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."ticket_assignees" VALIDATE CONSTRAINT "ck_0917_ticket_assignees_membership";
ALTER TABLE "build"."ticket_comment_reactions" ADD CONSTRAINT "ck_0917_ticket_comment_reactions_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."ticket_comment_reactions" VALIDATE CONSTRAINT "ck_0917_ticket_comment_reactions_membership";
ALTER TABLE "build"."ticket_watchers" ADD CONSTRAINT "ck_0917_ticket_watchers_membership" CHECK ("membership_id" IS NOT NULL) NOT VALID;
ALTER TABLE "build"."ticket_watchers" VALIDATE CONSTRAINT "ck_0917_ticket_watchers_membership";

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."meeting_attendees" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."project_members" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."project_team_members" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."project_workspace_members" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."project_whiteboard_shares" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."ticket_assignees" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."ticket_comment_reactions" ALTER COLUMN "membership_id" SET NOT NULL;
ALTER TABLE "build"."ticket_watchers" ALTER COLUMN "membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "build"."comment_drafts" DROP CONSTRAINT "ck_0917_comment_drafts_membership";
ALTER TABLE "build"."meeting_attendees" DROP CONSTRAINT "ck_0917_meeting_attendees_membership";
ALTER TABLE "build"."project_members" DROP CONSTRAINT "ck_0917_project_members_membership";
ALTER TABLE "build"."project_team_members" DROP CONSTRAINT "ck_0917_project_team_members_membership";
ALTER TABLE "build"."project_workspace_members" DROP CONSTRAINT "ck_0917_project_workspace_members_membership";
ALTER TABLE "build"."project_whiteboard_shares" DROP CONSTRAINT "ck_0917_project_whiteboard_shares_membership";
ALTER TABLE "build"."ticket_assignees" DROP CONSTRAINT "ck_0917_ticket_assignees_membership";
ALTER TABLE "build"."ticket_comment_reactions" DROP CONSTRAINT "ck_0917_ticket_comment_reactions_membership";
ALTER TABLE "build"."ticket_watchers" DROP CONSTRAINT "ck_0917_ticket_watchers_membership";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_comment_drafts_owner_ticket" ON "build"."comment_drafts" ("org_id", "membership_id", "ticket_id");
CREATE UNIQUE INDEX "uq_meeting_attendees_meeting_user" ON "build"."meeting_attendees" ("meeting_id", "membership_id");
CREATE UNIQUE INDEX "uniq_project_members_project_user" ON "build"."project_members" ("project_id", "membership_id");
CREATE UNIQUE INDEX "uniq_project_team_members_team_user" ON "build"."project_team_members" ("team_id", "membership_id");
CREATE UNIQUE INDEX "uniq_project_workspace_members_org_user" ON "build"."project_workspace_members" ("org_id", "membership_id");
CREATE UNIQUE INDEX "uniq_whiteboard_shares_board_user" ON "build"."project_whiteboard_shares" ("whiteboard_id", "membership_id");
CREATE UNIQUE INDEX "uniq_ticket_assignees_ticket_user" ON "build"."ticket_assignees" ("ticket_id", "membership_id");
CREATE UNIQUE INDEX "uniq_ticket_watcher" ON "build"."ticket_watchers" ("ticket_id", "membership_id");
CREATE UNIQUE INDEX "uq_comment_reaction_user_emoji" ON "build"."ticket_comment_reactions" ("comment_id", "membership_id", "emoji");
CREATE INDEX "idx_projects_manager" ON "build"."projects" ("org_id", "manager_membership_id");
CREATE INDEX "idx_tickets_org_assignee_status" ON "build"."tickets" ("org_id", "assignee_membership_id", "status");
CREATE INDEX "idx_tickets_org_assignee_due_open" ON "build"."tickets" ("org_id", "assignee_membership_id", "due_date") WHERE status <> 'DONE';
CREATE INDEX "idx_project_approvals_approver_status" ON "build"."project_approvals" ("org_id", "approver_membership_id", "status");
CREATE INDEX "idx_feedbucket_submissions_assignee" ON "build"."feedbucket_submissions" ("org_id", "assignee_membership_id") WHERE deleted_at IS NULL;
CREATE INDEX "idx_bugs_assignee" ON "build"."bugs" ("org_id", "assignee_membership_id");

--> statement-breakpoint
ALTER TABLE "build"."bugs" DROP COLUMN IF EXISTS "assignee_id";
ALTER TABLE "build"."comment_drafts" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."feedbucket_submissions" DROP COLUMN IF EXISTS "assignee_id";
ALTER TABLE "build"."meeting_attendees" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."okr_goals" DROP COLUMN IF EXISTS "owner_id", DROP COLUMN IF EXISTS "created_by";
ALTER TABLE "build"."project_approvals" DROP COLUMN IF EXISTS "approver_id";
ALTER TABLE "build"."project_members" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."project_team_members" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."project_workspace_members" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."project_whiteboard_shares" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "client_id", DROP COLUMN IF EXISTS "manager_id";
ALTER TABLE "build"."ticket_assignees" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."ticket_comment_reactions" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."ticket_watchers" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "assignee_id";
