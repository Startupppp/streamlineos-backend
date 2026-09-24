-- Rollback for migration 1123.
--
-- !! EMERGENCY USE ONLY — THIS ROLLBACK REMOVES CROSS-TENANT ISOLATION !!
--
-- The forward migration enabled RLS on ai_action_proposals and created the
-- tenant_isolation policy that binds every row to app.current_org_id(). Applying
-- this rollback drops that policy and disables RLS, leaving the table readable and
-- writable across ALL tenants by any session that holds the streamline_app grant.
-- Leave PII from all tenants (leave reasons, bonus amounts, candidate emails,
-- outbound mail bodies) accessible to application queries with no tenant predicate.
--
-- The explicit REVOKE ALL / GRANT to streamline_app that 1123 also applied is
-- NOT reversed here: restoring public access would be strictly worse. The grants
-- stay hardened; only the row-level policy and the RLS flag are removed.
--
-- Do NOT apply this on production unless you have an immediate operational blocker
-- that outweighs a full cross-tenant data exposure.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_action_proposals";
--> statement-breakpoint
ALTER TABLE "ai_action_proposals" DISABLE ROW LEVEL SECURITY;
