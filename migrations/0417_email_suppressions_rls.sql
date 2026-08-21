-- 0416: email_suppressions shipped in 0412 with NO row-level security, while every
-- sibling table (email_outbox, notification_events, notification_deliveries) enforces
-- it. Found by an adversarial check after the fact: as streamline_app with no tenant
-- GUC the table was fully readable. Tenant-scoped rows were relying on the service
-- filtering by org_id, which is an application predicate, not isolation (§20).
--
-- The policy deliberately mirrors email_outbox rather than the strict
-- org_id = app.current_org_id() used elsewhere:
--
--   org_id IS NULL  → platform-wide, always visible. A hard bounce is a property of
--                     the address, and the suppression check must work in post-commit
--                     and background contexts that have no tenant GUC. A strict policy
--                     would make every fire-and-forget send fail 42501 (SEQ-001).
--   org_id NOT NULL → ordinary tenant isolation.
--
-- USING takes current_org_id_or_null() so a read outside a tenant context sees only
-- the platform rows; WITH CHECK takes current_org_id() so a tenant-scoped WRITE
-- without context is refused rather than silently attributed.

SET lock_timeout = '5s';

ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "email_suppressions";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "email_suppressions"
  USING (
    CASE WHEN "org_id" IS NULL THEN true
         ELSE "org_id" = app.current_org_id_or_null() END
  )
  WITH CHECK (
    CASE WHEN "org_id" IS NULL THEN true
         ELSE "org_id" = app.current_org_id() END
  );
