SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'outcome'
  ) THEN
    RAISE EXCEPTION '1422-rollback precondition: build.roadmap_items.outcome does not exist — nothing to roll back';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'owner_membership_id'
  ) THEN
    RAISE EXCEPTION '1422-rollback precondition: build.roadmap_items.owner_membership_id does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_roadmap_items_org_owner_membership;
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items" DROP CONSTRAINT IF EXISTS fk_roadmap_items_org_owner_membership;
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items" DROP COLUMN IF EXISTS "owner_membership_id";
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items" DROP COLUMN IF EXISTS "outcome";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name IN ('outcome', 'owner_membership_id')
  ), '1422-rollback post-check: outcome or owner_membership_id survived the rollback';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_roadmap_items_org_owner_membership'
  ), '1422-rollback post-check: fk_roadmap_items_org_owner_membership survived the rollback';
END $$;
