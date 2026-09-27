-- Rollback for 1392_rls_managed_product_memberships.sql
-- Disables RLS on build.managed_product_memberships and removes the tenant_isolation policy.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.managed_product_memberships') IS NULL THEN
    RAISE EXCEPTION '1392-rollback precondition: build.managed_product_memberships does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "build"."managed_product_memberships";
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships" DISABLE ROW LEVEL SECURITY;
