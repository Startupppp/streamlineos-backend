SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'managed_products' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION '1423-rollback precondition: build.managed_products.version does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_managed_products_version_bump ON "build"."managed_products";
--> statement-breakpoint

ALTER TABLE "build"."managed_products" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'managed_products' AND column_name = 'version'
  ), '1423-rollback post-check: version survived the rollback';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_managed_products_version_bump'
  ), '1423-rollback post-check: trg_managed_products_version_bump survived the rollback, so it would fire against a column that no longer exists';
END $$;
