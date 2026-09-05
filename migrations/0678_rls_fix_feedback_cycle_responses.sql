-- Repairs feedback_cycle_responses: org_id column, backfill, NOT NULL, tenant FK,
-- index and RLS policy.
--
-- ORDERING NOTE (2026-09-05). This file sits at journal array position 457, but
-- 0678b_feedback_cycle_responses_rls_complete — the forward repair written to
-- *follow* it — sits at position 400. `db-bootstrap.mjs` and `apply-chain-cold.mjs`
-- both walk `journal.entries` in array order, so 0678b runs 57 entries EARLIER and
-- creates fk_feedback_cycle_responses_org first. This file's unguarded ADD then
-- failed with "constraint ... already exists", and db:bootstrap stops on failure —
-- which is why the cold build reached only 457/630.
--
-- The order came from main via the merge 70ff0db1d, not from a local renumbering:
-- the array positions are identical before and after 546175cbb, which changed only
-- `idx`. Rather than move a journal entry that main owns, every statement here is
-- now guarded so this file is correct in EITHER order — which is the convention the
-- rest of the tree already follows (see 0678b, and §4 of the NEO handoff on the 714
-- guarded FK adds).
--
-- The three statements that were not idempotent are marked below. This matters
-- beyond ordering: db-bootstrap skips by content hash, so editing this file makes it
-- re-run everywhere it had already applied.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
UPDATE feedback_cycle_responses r
SET org_id = fcr.org_id
FROM feedback_cycle_requests fcr
WHERE r.request_id = fcr.id;
--> statement-breakpoint
-- guarded: re-runnable after a partial or repeated application
DO $chk$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_fcr_org_id_not_null'
      AND conrelid = 'public.feedback_cycle_responses'::regclass
  ) THEN
    ALTER TABLE feedback_cycle_responses
      ADD CONSTRAINT chk_fcr_org_id_not_null
      CHECK (org_id IS NOT NULL) NOT VALID;
  END IF;
END $chk$;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  VALIDATE CONSTRAINT chk_fcr_org_id_not_null;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  DROP CONSTRAINT IF EXISTS chk_fcr_org_id_not_null;
--> statement-breakpoint
-- guarded: 0678b creates this same constraint and, at journal array position 400,
-- runs before this file. Unguarded, this is the statement that stopped the cold build.
DO $fk$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_feedback_cycle_responses_org'
      AND conrelid = 'public.feedback_cycle_responses'::regclass
  ) THEN
    ALTER TABLE feedback_cycle_responses
      ADD CONSTRAINT fk_feedback_cycle_responses_org
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $fk$;
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses
  VALIDATE CONSTRAINT fk_feedback_cycle_responses_org;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedback_cycle_responses_org_request
  ON feedback_cycle_responses(org_id, request_id);
--> statement-breakpoint
ALTER TABLE feedback_cycle_responses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $policy$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'feedback_cycle_responses' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON feedback_cycle_responses
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
  END IF;
END $policy$;