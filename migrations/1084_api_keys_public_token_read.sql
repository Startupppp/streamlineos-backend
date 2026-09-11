-- api_keys is read by ApiKeyGuard (src/common/auth/api-key.guard.ts), which looks the row up BY
-- the sha256 of the presented key in order to discover which organisation that key belongs to.
-- Guards run before TenantContextInterceptor, and in this case the row is what ANSWERS "which
-- org", so app.organization_id can never be set at that point.
--
-- The policy used app.current_org_id(), the throwing variant, so every API-key ingest raised
-- 42501 "no tenant context" and returned 500. The guard does not catch database errors, so the
-- whole /leads ingest surface was dead.
--
-- The fix is the arrangement migration 0384 already established for ten other secret-bearing
-- tables, agent_tokens among them: admit a row either by tenant, or to a caller who has proved
-- possession of that row's own secret by presenting its hash (app.public_token, set by
-- withPublicToken). This is narrower than a blanket "GUC unset means allow" — a caller sees
-- exactly the one row whose hash they already hold, and nothing else.
--
-- WITH CHECK stays strict, matching agent_tokens: the guard's last_used_at write now runs in a
-- real tenant transaction, because by then the org IS known — it came from the row just read.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "api_keys";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys"
  FOR ALL
  TO PUBLIC
  USING (
    "org_id" = app.current_org_id_or_null()
    OR "key_hash" = app.current_public_token_or_null()
  )
  WITH CHECK ("org_id" = app.current_org_id());
