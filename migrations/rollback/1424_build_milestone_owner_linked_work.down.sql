SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'milestone_id'
  ) THEN
    RAISE EXCEPTION '1424-rollback precondition: build.tickets.milestone_id does not exist — nothing to roll back';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_milestones' AND column_name = 'owner_membership_id'
  ) THEN
    RAISE EXCEPTION '1424-rollback precondition: build.project_milestones.owner_membership_id does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_tickets_org_milestone_live;
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS fk_tickets_org_milestone;
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "milestone_id";
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_milestones_org_owner_membership;
--> statement-breakpoint

ALTER TABLE "build"."project_milestones" DROP CONSTRAINT IF EXISTS fk_project_milestones_org_owner_membership;
--> statement-breakpoint

ALTER TABLE "build"."project_milestones" DROP COLUMN IF EXISTS "owner_membership_id";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'milestone_id'
  ), '1424-rollback post-check: build.tickets.milestone_id survived the rollback';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_milestones' AND column_name = 'owner_membership_id'
  ), '1424-rollback post-check: build.project_milestones.owner_membership_id survived the rollback';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN ('fk_tickets_org_milestone', 'fk_project_milestones_org_owner_membership')
  ), '1424-rollback post-check: a milestone foreign key survived the rollback';
END $$;
