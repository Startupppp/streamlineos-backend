-- Reverses 1084. Puts `api_keys` back on the plain tenant-only policy, removing
-- the public-token read arm.
--
-- ⚠ READ THIS BEFORE RUNNING IT. Applying this rollback RESTORES A KNOWN
-- PRODUCTION BREAKAGE. ApiKeyGuard (src/common/auth/api-key.guard.ts) looks the
-- row up by the sha256 of the presented key in order to DISCOVER which
-- organisation that key belongs to, and guards run before
-- TenantContextInterceptor — so app.organization_id cannot be set at that point.
-- With the tenant-only predicate back, `app.current_org_id()` throws and every
-- API-key request raises 42501 "no tenant context" and returns 500. The guard
-- does not catch database errors, so the whole /leads ingest surface is dead
-- again. It exists anyway, and is not declared @irreversible, because 1084
-- destroys no data and the prior schema state is exactly reproducible. A
-- rollback restores the state before the migration; it does not promise that
-- state was good. The reason 1084 exists is that it was not.
--
-- WHERE THE TEXT COMES FROM. The chain never spells this policy out per table:
-- 0378 is a catalog sweep that walks every public table carrying a text
-- `org_id`/`organization_id` and has no RLS yet, so it names no table and a grep
-- for `api_keys` finds nothing. `api_keys.org_id` is NOT NULL, which selects the
-- sweep's `tenant_required` branch, and that branch emits exactly:
--
--   CREATE POLICY tenant_isolation ON public.<t> FOR ALL
--     USING (org_id = app.current_org_id())
--     WITH CHECK (org_id = app.current_org_id())
--
-- which is also what 1084's own header describes it as replacing ("the policy
-- used app.current_org_id(), the throwing variant"). Two independent sources
-- agreeing is why this is transcribed rather than guessed.
--
-- RUN THESE TWO STATEMENTS IN ONE TRANSACTION. 1084 replaced the policy under
-- the SAME name, so reversing it cannot avoid a drop followed by a create —
-- there is no moment where both can exist. Row security is ENABLED on api_keys,
-- and a table left RLS-enabled with no policy denies every row to every
-- non-owner role, so between these two statements api_keys answers nothing.
-- Inside a transaction that window is invisible to every other session; outside
-- one it is a live outage for as long as it takes to run the CREATE.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "api_keys";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys"
  FOR ALL
  TO PUBLIC
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
