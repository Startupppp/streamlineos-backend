-- Custom SQL migration file, put your code below! --

-- The importer, resumable and reversible.
--
-- 0229 built the importer to run inline in one HTTP request, capped at five
-- thousand rows. Everything here exists so the commit can instead be a durable
-- workflow executing a memoised step per batch of rows, and so the result can be
-- taken back inside a window that was promised rather than assumed.
--
-- Four things are load-bearing.
--
-- `crm_import_rows.reverted_at` and the already-present `committed_at` are the
-- CLAIMS, not just timestamps. A batch step re-runs whenever its previous
-- attempt failed -- the runtime memoises only COMPLETED steps -- and two runs
-- can legitimately overlap after a dead-letter and a fresh commit. Every row is
-- claimed with `committed_at IS NULL` (or `reverted_at IS NULL`) inside its own
-- savepoint before anything is written, which is what makes a re-run a no-op
-- instead of a second copy of a customer.
--
-- `revert_deadline_at` is stamped when the commit finishes rather than derived
-- from `committed_at` plus a constant in code. It is a promise made to the
-- tenant at that moment; deriving it would mean shortening the window in a
-- deploy silently retracted an undo somebody was relying on.
--
-- `chk_crm_import_rows_outcome` is widened rather than dropped. Its point stands
-- -- a committed row records what it did, so it can be undone -- and the two new
-- actions keep it: a `review` row must carry the finding it filed, a `merge` row
-- wrote nothing because its values were folded into the row it repeats. The one
-- genuine relaxation is `error IS NOT NULL`: a row Postgres refused is marked
-- done with its error, because leaving it outstanding would have every later
-- attempt retry the same bad cell and hold the import open forever.
--
-- `idx_crm_import_rows_pending` is partial on the outstanding rows. Each batch
-- step reads one window of what is left, and a partial index shrinks as the
-- import progresses -- the difference between fifty batches costing fifty scans
-- of the whole file and fifty scans of the remainder.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "crm_imports" ADD COLUMN IF NOT EXISTS "revert_workflow_run_id" text;
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD COLUMN IF NOT EXISTS "revert_deadline_at" timestamp;

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD COLUMN IF NOT EXISTS "match" jsonb;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD COLUMN IF NOT EXISTS "reverted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD COLUMN IF NOT EXISTS "data_quality_finding_id" text;

--> statement-breakpoint
-- `reverting` is a real state, not a flag: a five-thousand-row undo is many
-- transactions, and without it a run that stopped halfway is indistinguishable
-- from one that never started.
ALTER TABLE "crm_imports" DROP CONSTRAINT IF EXISTS "chk_crm_imports_status";
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_status"
  CHECK ("status" IN ('previewing', 'committing', 'committed', 'reverting', 'reverted', 'failed'));

--> statement-breakpoint
-- A deadline only means anything once there is something to reverse.
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_revert_window"
  CHECK ("revert_deadline_at" IS NULL OR "committed_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_imports" VALIDATE CONSTRAINT "chk_crm_imports_revert_window";

--> statement-breakpoint
-- `merge` is a row folded into an earlier row of the same file; `review` is a
-- row the duplicate scorer would not commit to, which writes nothing and files a
-- data-quality finding instead.
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_action";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_action"
  CHECK ("action" IN ('create', 'update', 'merge', 'review', 'skip'));

--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_outcome";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_outcome"
  CHECK (
    "committed_at" IS NULL
    OR "error" IS NOT NULL
    OR "action" IN ('skip', 'merge')
    OR ("action" = 'create' AND "created_party_id" IS NOT NULL)
    OR ("action" = 'update' AND "previous" IS NOT NULL)
    OR ("action" = 'review' AND "data_quality_finding_id" IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" VALIDATE CONSTRAINT "chk_crm_import_rows_outcome";

--> statement-breakpoint
-- Nothing can be put back that was never written.
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_reverted"
  CHECK ("reverted_at" IS NULL OR "committed_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" VALIDATE CONSTRAINT "chk_crm_import_rows_reverted";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_import_rows_pending"
  ON "crm_import_rows" ("organization_id", "crm_import_id", "row_number")
  WHERE "committed_at" IS NULL;
