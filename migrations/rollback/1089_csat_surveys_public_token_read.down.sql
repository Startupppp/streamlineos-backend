-- Reverses 1089. Puts `csat_surveys` back on the plain tenant-only policy,
-- removing the public-token read arm.
--
-- ⚠ READ THIS BEFORE RUNNING IT. Applying this rollback BREAKS THE PUBLIC CSAT
-- SUBMIT ROUTE. That route is reached by a recipient who holds nothing but the
-- survey's `public_token`, so no app.organization_id is set when the row is
-- looked up. With the tenant-only predicate back, `app.current_org_id()` throws
-- and the lookup raises 42501 "no tenant context" — every emailed CSAT link
-- stops working. It is not declared @irreversible because 1089 destroys no data
-- and the prior schema state is exactly reproducible: a rollback restores the
-- state before the migration; it does not promise that state was good.
--
-- WHAT IT DOES *NOT* REOPEN, which is the point worth being precise about. 0384
-- left csat_surveys off the public-read arm deliberately, because the submit
-- route then looked the row up by its SERIAL id and a countable id would let
-- anyone walk any tenant's surveys. 1089 was safe only because the route had
-- moved to the unguessable token first. Rolling the policy back does not roll
-- the route back — it is still keyed by token — so this restores the old
-- RESTRICTION without restoring the old enumeration risk. The risk 0384 was
-- avoiding came from the route, not from the policy.
--
-- WHERE THE TEXT COMES FROM. The chain never spells this policy out per table:
-- 0378 is a catalog sweep over every public table carrying a text
-- `org_id`/`organization_id` and no RLS yet, so it names no table and a grep for
-- `csat_surveys` finds only 0384's prose. `csat_surveys.org_id` is NOT NULL,
-- which selects the sweep's `tenant_required` branch, and that branch emits
-- exactly the USING/WITH CHECK pair below.
--
-- RUN THESE TWO STATEMENTS IN ONE TRANSACTION. 1089 replaced the policy under
-- the SAME name, so reversing it is necessarily a drop followed by a create, and
-- row security is ENABLED on csat_surveys: between the two statements the table
-- has no policy and denies every row to every non-owner role. Inside a
-- transaction that window is invisible; outside one it is a live outage.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "csat_surveys";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "csat_surveys"
  FOR ALL
  TO PUBLIC
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
