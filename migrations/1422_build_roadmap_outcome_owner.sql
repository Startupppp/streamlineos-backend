SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.roadmap_items') IS NULL THEN
    RAISE EXCEPTION '1422 precondition: build.roadmap_items is absent';
  END IF;
  IF to_regclass('public.organization_members') IS NULL THEN
    RAISE EXCEPTION '1422 precondition: public.organization_members is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'created_by'
  ) THEN
    RAISE EXCEPTION '1422 precondition: build.roadmap_items.created_by is absent, so there would be no authorship stamp to distinguish the new owner column from';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.contype IN ('p', 'u')
      AND c.conrelid = 'public.organization_members'::regclass
      AND c.conkey @> ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.organization_members'::regclass AND attname = 'org_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.organization_members'::regclass AND attname = 'id')
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION '1422 precondition: public.organization_members has no unique constraint covering (org_id, id), so a composite owner FK cannot be created';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items" ADD COLUMN IF NOT EXISTS "outcome" text;
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items" ADD COLUMN IF NOT EXISTS "owner_membership_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."roadmap_items"
  DROP CONSTRAINT IF EXISTS fk_roadmap_items_org_owner_membership;
--> statement-breakpoint
ALTER TABLE "build"."roadmap_items"
  ADD CONSTRAINT fk_roadmap_items_org_owner_membership
  FOREIGN KEY (org_id, owner_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (owner_membership_id) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."roadmap_items"
  VALIDATE CONSTRAINT fk_roadmap_items_org_owner_membership;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_roadmap_items_org_owner_membership
  ON build.roadmap_items (org_id, owner_membership_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'outcome'
  ), '1422 post-check: outcome was not added to build.roadmap_items';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'outcome'
  ) = 'YES', '1422 post-check: outcome must stay nullable — a NOT NULL column would force a backfill that invents an outcome statement for every roadmap item ever created';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."roadmap_items" WHERE "outcome" IS NOT NULL
  ), '1422 post-check: outcome was backfilled, which manufactures product intent that was never recorded';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'owner_membership_id'
  ), '1422 post-check: owner_membership_id was not added to build.roadmap_items';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'owner_membership_id'
  ) = 'YES', '1422 post-check: owner_membership_id must stay nullable — an unowned roadmap item is a legitimate state and a NOT NULL column would force created_by to be copied in, which is the exact authorship/ownership conflation this column exists to end';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."roadmap_items" WHERE "owner_membership_id" IS NOT NULL
  ), '1422 post-check: owner_membership_id was backfilled from created_by, which asserts that whoever typed the item owns delivering it';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_roadmap_items_org_owner_membership'
      AND conrelid = 'build.roadmap_items'::regclass
      AND convalidated
  ), '1422 post-check: fk_roadmap_items_org_owner_membership is missing or unvalidated, so an owner could reference a membership in another tenant';

  ASSERT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_roadmap_items_org_owner_membership'
  ), '1422 post-check: idx_roadmap_items_org_owner_membership is missing, so filtering the roadmap by owner would sequentially scan every item in the tenant';
END $$;
