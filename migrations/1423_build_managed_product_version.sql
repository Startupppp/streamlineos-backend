SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.managed_products') IS NULL THEN
    RAISE EXCEPTION '1423 precondition: build.managed_products is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'build' AND p.proname = 'bump_sibling_version'
  ) THEN
    RAISE EXCEPTION '1423 precondition: build.bump_sibling_version() is absent — migration 1395 must be applied first, because reusing one bump function is what keeps every build aggregate on the same token semantics';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."managed_products" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_managed_products_version_bump ON "build"."managed_products";
--> statement-breakpoint

CREATE TRIGGER trg_managed_products_version_bump
  BEFORE UPDATE ON "build"."managed_products"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'managed_products' AND column_name = 'version'
  ), '1423 post-check: version was not added to build.managed_products';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'managed_products' AND column_name = 'version'
  ) = 'NO', '1423 post-check: version must be NOT NULL — a nullable concurrency token compares as unknown, so every If-Match check would silently pass';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."managed_products" WHERE "version" IS NULL
  ), '1423 post-check: an existing managed product has a null version, so its first edit would bypass the conflict check';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_managed_products_version_bump'
      AND tgrelid = 'build.managed_products'::regclass
  ), '1423 post-check: trg_managed_products_version_bump was not created, so a managed-product edit would leave the token stale and every later edit would collide against a version that never advanced';
END $$;
