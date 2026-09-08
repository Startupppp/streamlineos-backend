-- 0514.down — Remove tenant isolation from inv_webhook_event_subscriptions.
--
-- Reversing an RLS policy is the one rollback that makes a database LESS safe
-- rather than merely older: with the policy gone and RLS disabled, every row in
-- this table is visible to every tenant that can reach it. That is what 0514
-- existed to prevent, so this file is the inverse of a security control and
-- should only ever run as part of a descent that is going all the way.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_webhook_event_subscriptions";
--> statement-breakpoint
ALTER TABLE "inv_webhook_event_subscriptions" DISABLE ROW LEVEL SECURITY;
