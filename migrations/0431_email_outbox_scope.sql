-- 0431: SCH-014, resolved differently than the audit proposed.
--
-- The audit's remedy was `organization_id NOT NULL`. That premise is wrong, and applying
-- it would have broken authentication: `resendVerification` and password reset send
-- before the user belongs to any organization, so those emails legitimately have no
-- tenant. NOT NULL would have failed every one of them.
--
-- The actual defect is the RLS policy, which read:
--
--     CASE WHEN organization_id IS NULL THEN true
--          ELSE organization_id = app.current_org_id_or_null() END
--
-- A NULL org is therefore visible from *every* tenant. All 34 rows in the table are
-- NULL, because callers never passed an organization id — so at the time of writing,
-- every email ever queued is readable by every organization, bodies included.
--
-- The fix keeps NULL legal but makes it MEAN something enforceable:
--   * `scope = 'PLATFORM'` — no tenant by nature (verification, password reset).
--   * `scope = 'TENANT'`   — must carry an organization_id, and is isolated to it.
-- A CHECK ties the two columns together so "tenant email with no tenant" is no longer
-- representable, and the policy stops treating NULL as a wildcard.

SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "email_outbox_scope" AS ENUM ('PLATFORM','TENANT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "email_outbox"
  ADD COLUMN IF NOT EXISTS "scope" "email_outbox_scope" NOT NULL DEFAULT 'PLATFORM';
--> statement-breakpoint

-- Existing rows all have organization_id IS NULL, so PLATFORM is the only assignment
-- consistent with the CHECK below. They are historical and cannot be re-attributed:
-- the org they belonged to, if any, was never recorded.
UPDATE "email_outbox" SET "scope" = 'TENANT' WHERE "organization_id" IS NOT NULL;
--> statement-breakpoint

-- NOT VALID then VALIDATE: adding a validated CHECK takes ACCESS EXCLUSIVE for the
-- length of the full-table scan.
DO $$ BEGIN
  ALTER TABLE "email_outbox"
    ADD CONSTRAINT "email_outbox_scope_org_consistency"
    CHECK (("scope" = 'TENANT' AND "organization_id" IS NOT NULL)
        OR ("scope" = 'PLATFORM' AND "organization_id" IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "email_outbox" VALIDATE CONSTRAINT "email_outbox_scope_org_consistency";
--> statement-breakpoint

-- The policy that actually closes the hole. A platform row is visible only when there
-- is no tenant GUC at all — that is the cron flush's own context, and no tenant can
-- reach it. A tenant row is visible only inside its own tenant.
DROP POLICY IF EXISTS "tenant_isolation" ON "email_outbox";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "email_outbox"
  USING (
    CASE WHEN "organization_id" IS NULL
      THEN app.current_org_id_or_null() IS NULL
      ELSE "organization_id" = app.current_org_id_or_null()
    END
  )
  WITH CHECK (
    CASE WHEN "organization_id" IS NULL
      THEN app.current_org_id_or_null() IS NULL
      ELSE "organization_id" = app.current_org_id()
    END
  );
--> statement-breakpoint

-- The flush claims by (status, next_attempt_at) and now also splits by scope.
CREATE INDEX IF NOT EXISTS "idx_email_outbox_scope_due"
  ON "email_outbox" ("scope", "status", "next_attempt_at");
