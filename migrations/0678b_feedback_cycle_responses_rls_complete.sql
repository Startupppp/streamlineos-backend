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

SET statement_timeout = 0;
SET lock_timeout = '5s';

--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON feedback_cycle_responses;

--> statement-breakpoint
CREATE POLICY tenant_isolation ON feedback_cycle_responses
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedback_cycle_responses_org_request
  ON feedback_cycle_responses (org_id, request_id);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_feedback_cycle_responses_org'
      AND conrelid = 'public.feedback_cycle_responses'::regclass
  ) THEN
    ALTER TABLE feedback_cycle_responses
      ADD CONSTRAINT fk_feedback_cycle_responses_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  VALIDATE CONSTRAINT fk_feedback_cycle_responses_org;
