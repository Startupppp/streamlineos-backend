-- Undo 0280.
--
-- The columns go last and the constraints first, because a CHECK that still
-- names a dropped column is an error rather than a no-op. Any import sitting at
-- `reverting` is moved back to `committed`: it is the state the widened CHECK
-- allowed, and the rows it already put back are recorded on the rows themselves,
-- so re-running the undo skips them.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_reverted";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_outcome";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_outcome"
  CHECK (
    "committed_at" IS NULL
    OR "action" = 'skip'
    OR ("action" = 'create' AND "created_party_id" IS NOT NULL)
    OR ("action" = 'update' AND "previous" IS NOT NULL)
  ) NOT VALID;

--> statement-breakpoint
UPDATE "crm_import_rows" SET "action" = 'skip' WHERE "action" IN ('merge', 'review');
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP CONSTRAINT IF EXISTS "chk_crm_import_rows_action";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_action"
  CHECK ("action" IN ('create', 'update', 'skip'));

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_crm_import_rows_pending";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP COLUMN IF EXISTS "data_quality_finding_id";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP COLUMN IF EXISTS "reverted_at";
--> statement-breakpoint
ALTER TABLE "crm_import_rows" DROP COLUMN IF EXISTS "match";

--> statement-breakpoint
UPDATE "crm_imports" SET "status" = 'committed' WHERE "status" = 'reverting';
--> statement-breakpoint
ALTER TABLE "crm_imports" DROP CONSTRAINT IF EXISTS "chk_crm_imports_revert_window";
--> statement-breakpoint
ALTER TABLE "crm_imports" DROP CONSTRAINT IF EXISTS "chk_crm_imports_status";
--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_status"
  CHECK ("status" IN ('previewing', 'committing', 'committed', 'reverted', 'failed'));
--> statement-breakpoint
ALTER TABLE "crm_imports" DROP COLUMN IF EXISTS "revert_deadline_at";
--> statement-breakpoint
ALTER TABLE "crm_imports" DROP COLUMN IF EXISTS "revert_workflow_run_id";
