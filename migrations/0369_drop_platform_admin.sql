SET statement_timeout = 0;

-- =============================================================================
-- 0369 — remove the platform-owner concern from this repo
-- =============================================================================
-- The platform owner moves to a separate application. This repo now serves
-- tenants only, so `users.is_platform_admin` has no reader: the claim, the
-- guard, the bypass checks and the admin surfaces were all removed in code.
--
-- Leaving the column would be worse than dropping it — a flag nothing enforces
-- reads like a live privilege. Verified 0 rows set it before the drop; the
-- guard below aborts if that is ever untrue on another environment.
-- =============================================================================

DO $$
DECLARE
  admin_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_platform_admin'
  ) THEN
    EXECUTE 'SELECT count(*) FROM users WHERE is_platform_admin = true' INTO admin_count;
    IF admin_count > 0 THEN
      RAISE EXCEPTION
        '0369: % user(s) still flagged is_platform_admin — migrate them to the platform app before dropping', admin_count;
    END IF;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "is_platform_admin";
