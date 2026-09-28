SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_milestones') IS NULL THEN
    RAISE EXCEPTION '1424 precondition: build.project_milestones is absent';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1424 precondition: build.tickets is absent';
  END IF;
  IF to_regclass('public.organization_members') IS NULL THEN
    RAISE EXCEPTION '1424 precondition: public.organization_members is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_project_milestones_org_id'
      AND conrelid = 'build.project_milestones'::regclass
  ) THEN
    RAISE EXCEPTION '1424 precondition: uniq_project_milestones_org_id is absent, so a composite (org_id, milestone_id) FK from build.tickets cannot be created and a ticket could point at a milestone in another tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'milestone_id'
  ) THEN
    RAISE EXCEPTION '1424 precondition: build.tickets.milestone_id already exists, so linked work is already modelled and this migration would be describing a second source of truth';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_milestones" ADD COLUMN IF NOT EXISTS "owner_membership_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."project_milestones"
  DROP CONSTRAINT IF EXISTS fk_project_milestones_org_owner_membership;
--> statement-breakpoint
ALTER TABLE "build"."project_milestones"
  ADD CONSTRAINT fk_project_milestones_org_owner_membership
  FOREIGN KEY (org_id, owner_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (owner_membership_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_milestones"
  VALIDATE CONSTRAINT fk_project_milestones_org_owner_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_milestones_org_owner_membership
  ON build.project_milestones (org_id, owner_membership_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "milestone_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."tickets"
  DROP CONSTRAINT IF EXISTS fk_tickets_org_milestone;
--> statement-breakpoint
ALTER TABLE "build"."tickets"
  ADD CONSTRAINT fk_tickets_org_milestone
  FOREIGN KEY (org_id, milestone_id)
  REFERENCES build.project_milestones (org_id, id)
  ON DELETE SET NULL (milestone_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets"
  VALIDATE CONSTRAINT fk_tickets_org_milestone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_org_milestone_live
  ON build.tickets (org_id, milestone_id)
  WHERE deleted_at IS NULL AND milestone_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_milestones' AND column_name = 'owner_membership_id'
  ), '1424 post-check: owner_membership_id was not added to build.project_milestones';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_milestones' AND column_name = 'owner_membership_id'
  ) = 'YES', '1424 post-check: owner_membership_id must stay nullable — an unowned milestone is a legitimate state, and a NOT NULL column would force created_by to be copied in, which asserts that whoever created the milestone owns delivering it';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."project_milestones" WHERE "owner_membership_id" IS NOT NULL
  ), '1424 post-check: owner_membership_id was backfilled from created_by, conflating authorship with ownership';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_project_milestones_org_owner_membership'
      AND conrelid = 'build.project_milestones'::regclass
      AND convalidated
  ), '1424 post-check: fk_project_milestones_org_owner_membership is missing or unvalidated, so a milestone owner could reference a membership in another tenant';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'milestone_id'
  ), '1424 post-check: milestone_id was not added to build.tickets';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'milestone_id'
  ) = 'YES', '1424 post-check: milestone_id must stay nullable — most work belongs to no milestone';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."tickets" WHERE "milestone_id" IS NOT NULL
  ), '1424 post-check: milestone_id was backfilled, which invents a delivery commitment for work nobody scheduled against a milestone';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_tickets_org_milestone'
      AND conrelid = 'build.tickets'::regclass
      AND convalidated
  ), '1424 post-check: fk_tickets_org_milestone is missing or unvalidated, so a ticket could be linked to a milestone in another tenant';

  ASSERT (
    SELECT confdeltype FROM pg_constraint
    WHERE conname = 'fk_tickets_org_milestone' AND conrelid = 'build.tickets'::regclass
  ) = 'n', '1424 post-check: fk_tickets_org_milestone must be ON DELETE SET NULL — a cascade would delete the work itself when a milestone is deleted, turning a planning change into data loss';

  ASSERT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_tickets_org_milestone_live'
  ), '1424 post-check: idx_tickets_org_milestone_live is missing, so listing a milestone''s linked work would sequentially scan every ticket in the tenant';
END $$;
