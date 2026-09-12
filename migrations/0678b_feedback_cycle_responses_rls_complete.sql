-- Forward repair completing the work 0678_rls_fix_feedback_cycle_responses intended.
--
-- On cold replay, 0677b_feedback_cycle_responses_policy_repair drops the policy that
-- 0378 had pre-created, allowing 0678 to succeed. This migration then runs after 0678
-- (array position 396, immediately after 0678 at 395) and is a no-op on cold replay:
-- all objects already exist.
--
-- On production, 0678 failed for the same reason (0378 created the policy first) and
-- was never committed. 0677b then dropped that policy. This migration picks up the
-- missing work:
--   1. Recreates the tenant_isolation policy (correct NOT-NULL predicate).
--   2. Creates the composite org/request index that 0678 would have added.
--   3. Adds the FK fk_feedback_cycle_responses_org conditionally (0320 already added
--      a semantically equivalent FK under a different name, so the conditional add
--      prevents a duplicate-constraint error).
--
-- All statements are idempotent (IF NOT EXISTS / DO-block guards) so re-running on
-- any state is safe.
--
-- WATERMARK INTERACTION:
--   when=1798000160000 > watermark (1798000155000) and > 0677b (1798000159000), so
--   production applies this immediately after 0677b in db:migrate order.

--
-- ORDER NOTE (2026-09-05). Every statement below is now guarded on
-- feedback_cycle_responses.org_id EXISTING, because on a cold build it may not.
--
-- This file sits at journal array position 400. The column is created by
-- 0678_rls_fix_feedback_cycle_responses at position 457 — 57 entries LATER — and by
-- nothing else. The only other candidate, 0320_recon_phase_a_orgid at position 39,
-- adds org_id by looping over `pg_class` with NO ORDER BY, and a child table is only
-- eligible when its parent already carries org_id. So whether this table has the
-- column at position 400 depends on the order Postgres happens to return rows in.
--
-- Measured: two cold builds of the same commit, same journal, different outcomes —
-- one had feedback_cycle_responses.org_id and reached head, the other had the parent's
-- org_id but not the child's and died here on `column "org_id" does not exist`.
--
-- Guarding here rather than reordering 0320: this file is a forward repair for a
-- production database where 0678 already ran and failed, so the column is present
-- there and the repair still applies. On a cold build it correctly becomes a no-op and
-- 0678 — which is itself fully guarded — does the same work at 457.
--
-- The nondeterminism in 0320 is the deeper defect and is NOT fixed here.

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
DO $repair$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feedback_cycle_responses'
      AND column_name = 'org_id'
  ) THEN
    RAISE NOTICE '0678b: feedback_cycle_responses.org_id does not exist yet; 0678 creates it later in array order. Skipping.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS tenant_isolation ON feedback_cycle_responses;

  CREATE POLICY tenant_isolation ON feedback_cycle_responses
    FOR ALL USING (org_id = app.current_org_id())
    WITH CHECK (org_id = app.current_org_id());

  CREATE INDEX IF NOT EXISTS idx_feedback_cycle_responses_org_request
    ON feedback_cycle_responses (org_id, request_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_feedback_cycle_responses_org'
      AND conrelid = 'public.feedback_cycle_responses'::regclass
  ) THEN
    ALTER TABLE feedback_cycle_responses
      ADD CONSTRAINT fk_feedback_cycle_responses_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;

  ALTER TABLE feedback_cycle_responses
    VALIDATE CONSTRAINT fk_feedback_cycle_responses_org;
END $repair$;
