-- Reverses 1083. Restores the `tenant_isolation` policy 0608 created on
-- `account_organization_index` and removes the `identity_or_tenant_access`
-- policy 1083 replaced it with.
--
-- PRIOR STATE IS FULLY CAPTURED HERE, unlike the sibling control-plane
-- rollbacks. 0608 lines 245-250 create this table's policy in the chain, so the
-- text below is transcribed from that migration rather than reconstructed:
--
--   CREATE POLICY "tenant_isolation" ON "account_organization_index"
--     FOR ALL
--     USING ("org_id" = app.current_org_id_or_null() OR "user_id" = app.current_user_id_or_null())
--     WITH CHECK (...same...);
--
-- ONE THING WORTH KNOWING. 1083's header describes the policy it replaced as
-- using `app.current_org_id()`, the THROWING variant. That is not what 0608
-- wrote — 0608 wrote the non-throwing `_or_null` form above. The throwing shape
-- existed on databases a later catalog sweep had reached out of band, which is
-- drift this chain never contained. This rollback restores what the CHAIN had,
-- which is the only prior state it can honestly claim to know.
--
-- RLS STAYS ENABLED, and the ordering below is deliberate because of it. 1083
-- renamed the policy as well as rewriting it, so unlike the api_keys rollback
-- both can exist at once: `tenant_isolation` is created while
-- `identity_or_tenant_access` is still in place, and only then is the latter
-- dropped. The table therefore always carries at least one policy, and is never
-- left RLS-enabled and policy-less — which would deny every row to every
-- non-owner role. The leading DROP IF EXISTS is idempotency for a re-run, not
-- sequencing; it is a no-op on the state 1083 leaves behind.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "account_organization_index";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "account_organization_index"
  FOR ALL
  USING ("org_id" = app.current_org_id_or_null() OR "user_id" = app.current_user_id_or_null())
  WITH CHECK ("org_id" = app.current_org_id_or_null() OR "user_id" = app.current_user_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "identity_or_tenant_access" ON "account_organization_index";
