SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-109 / Phase 1 gate. This is the one inventory table of 66 that the audit
-- found with RLS disabled and no policy. Grants arrive via ALTER DEFAULT
-- PRIVILEGES, so the absence was silent: every subscription row was readable by
-- the application role across tenants.
ALTER TABLE "inv_webhook_event_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_webhook_event_subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_webhook_event_subscriptions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
