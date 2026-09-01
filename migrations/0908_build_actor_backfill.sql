-- 0906: Backfill membership_id companion columns for all Build-module tables added by 0900.
--
-- Migration 0900 added the companion columns and NOT VALID FKs but omitted backfill UPDATE
-- statements. This migration fills them so that VALIDATE in 0907 can succeed for existing rows,
-- and so that membership revocation (SET NULL) actually has rows to NULL out.
--
-- Every UPDATE joins organization_members on (org_id, user_id) matching the legacy text column.
-- All legacy columns in the build schema are TEXT (matching organization_members.user_id TEXT),
-- so no type-cast is required.
--
-- All tables live in the "build" schema (migrated by 0432_build_schema). Fully-qualified names
-- are used throughout because the Neon pooler drops search_path startup params.

SET lock_timeout = '5s';

--> statement-breakpoint
UPDATE "build"."projects" p
SET "manager_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = p.org_id
  AND om.user_id = p.manager_id
  AND p.manager_id IS NOT NULL
  AND p."manager_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."projects" p
SET "client_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = p.org_id
  AND om.user_id = p.client_id
  AND p.client_id IS NOT NULL
  AND p."client_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."comment_drafts" cd
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = cd.org_id
  AND om.user_id = cd.user_id
  AND cd."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."okr_goals" g
SET "owner_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = g.org_id
  AND om.user_id = g.owner_id
  AND g.owner_id IS NOT NULL
  AND g."owner_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."okr_goals" g
SET "created_by_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = g.org_id
  AND om.user_id = g.created_by
  AND g.created_by IS NOT NULL
  AND g."created_by_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."ticket_watchers" tw
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = tw.org_id
  AND om.user_id = tw.user_id
  AND tw."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."ticket_checklist_items" tci
SET "assignee_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = tci.org_id
  AND om.user_id = tci.assignee_id
  AND tci.assignee_id IS NOT NULL
  AND tci."assignee_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."ticket_comment_reactions" tcr
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = tcr.org_id
  AND om.user_id = tcr.user_id
  AND tcr."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."meeting_attendees" ma
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = ma.org_id
  AND om.user_id = ma.user_id
  AND ma."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."meeting_standup_entries" mse
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = mse.org_id
  AND om.user_id = mse.user_id
  AND mse."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."project_whiteboard_shares" pws
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = pws.org_id
  AND om.user_id = pws.user_id
  AND pws."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."feedbucket_submissions" fs
SET "assignee_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = fs.org_id
  AND om.user_id = fs.assignee_id
  AND fs.assignee_id IS NOT NULL
  AND fs."assignee_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."project_team_members" ptm
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = ptm.org_id
  AND om.user_id = ptm.user_id
  AND ptm."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."project_workspace_members" pwm
SET "membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = pwm.org_id
  AND om.user_id = pwm.user_id
  AND pwm."membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."bugs" b
SET "assignee_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = b.org_id
  AND om.user_id = b.assignee_id
  AND b.assignee_id IS NOT NULL
  AND b."assignee_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."bugs" b
SET "qa_owner_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = b.org_id
  AND om.user_id = b.qa_owner_id
  AND b.qa_owner_id IS NOT NULL
  AND b."qa_owner_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."test_runs" tr
SET "tester_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = tr.org_id
  AND om.user_id = tr.tester_id
  AND tr.tester_id IS NOT NULL
  AND tr."tester_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "build"."change_requests" cr
SET "approval_owner_membership_id" = om.id
FROM "public"."organization_members" om
WHERE om.org_id = cr.org_id
  AND om.user_id = cr.approval_owner_id
  AND cr.approval_owner_id IS NOT NULL
  AND cr."approval_owner_membership_id" IS NULL;
