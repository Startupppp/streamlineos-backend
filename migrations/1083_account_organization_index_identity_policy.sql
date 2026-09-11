-- account_organization_index is a per-user projection of "which organisations does
-- this person belong to". Every read of it happens in the IDENTITY phase, inside
-- withIdentity() (src/common/tenant/with-identity.ts), which sets app.user_id and
-- deliberately NO org GUC — because these queries are how the organisation gets
-- chosen. JwtAuthGuard.fetchOrgContext (src/common/auth/jwt-auth.guard.ts:284) is
-- the clearest case: it runs in a GUARD, before TenantContextInterceptor exists, and
-- its whole job is to answer "which org is this user in".
--
-- The prior "tenant_isolation" policy used app.current_org_id(), the THROWING
-- variant, so every one of those reads raised 42501 "no tenant context". That took
-- out GET /org/setup/session, GET /organization and GET /me/access for any caller
-- whose token carried no orgId — which is exactly the population sitting on the
-- org-setup wizard, so the wizard could never be completed.
--
-- This is the same defect migration 1082 fixed for organization_placement. That one
-- had no user column and so had to admit the whole control plane when the GUC was
-- unset; this table HAS user_id, so it can be scoped tighter: mirror the policy
-- organization_members already carries for the same facts, admitting the caller's
-- own rows during the identity phase and org-scoped rows once a tenant is known.
-- Access is therefore not widened — organization_members already exposes exactly
-- these rows to exactly this caller.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "account_organization_index";
--> statement-breakpoint
DROP POLICY IF EXISTS "identity_or_tenant_access" ON "account_organization_index";
--> statement-breakpoint
CREATE POLICY "identity_or_tenant_access" ON "account_organization_index"
  FOR ALL
  TO PUBLIC
  USING (
    "org_id" = app.current_org_id_or_null()
    OR "user_id" = app.current_user_id_or_null()
  )
  WITH CHECK (
    "org_id" = app.current_org_id_or_null()
    OR "user_id" = app.current_user_id_or_null()
  );
