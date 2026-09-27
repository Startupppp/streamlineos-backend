-- Enable row-level security on build.managed_product_memberships.
--
-- This table carries a NOT NULL org_id and has had ALTER DEFAULT PRIVILEGES grants
-- since creation, but no RLS policy was ever authored for it. Every SELECT by the
-- app role therefore read org-wide and returned 200 silently.
--
-- The audit in CCG-7 (docs/build-module/99-cross-cutting-gaps.md) confirmed that
-- every read and write path for this table runs inside a tenant transaction via
-- TenantContextInterceptor. No background sweep and no after-commit hook touches
-- it. Enabling the policy is therefore safe: no call path will encounter a 42501.
--
-- Pattern follows 0650 and 1295: ENABLE, DROP IF EXISTS, CREATE, GRANT.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.managed_product_memberships') IS NULL THEN
    RAISE EXCEPTION '1392 precondition: build.managed_product_memberships does not exist';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."managed_product_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."managed_product_memberships";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."managed_product_memberships"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."managed_product_memberships" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT (
    SELECT relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'build' AND c.relname = 'managed_product_memberships'
  ), '1392 post-check: RLS was not enabled on build.managed_product_memberships';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'build'
      AND tablename = 'managed_product_memberships'
      AND policyname = 'tenant_isolation'
  ), '1392 post-check: tenant_isolation policy not found on build.managed_product_memberships';
END $$;
