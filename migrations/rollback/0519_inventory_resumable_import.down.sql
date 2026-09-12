-- 0519.down — Remove resumable import staging.
--
-- Drops the staged-row table and the resume bookkeeping on the job. Any import
-- that is mid-flight when this runs cannot be resumed afterwards; it has no
-- next_row to resume from and its staged rows are gone.
--
-- @data-loss: inv_import_rows, inv_import_jobs
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_import_rows" CASCADE;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_import_jobs_org_idempotency";
--> statement-breakpoint
ALTER TABLE "inv_import_jobs"
  DROP COLUMN IF EXISTS "staged_rows",
  DROP COLUMN IF EXISTS "next_row",
  DROP COLUMN IF EXISTS "chunk_size",
  DROP COLUMN IF EXISTS "checksum",
  DROP COLUMN IF EXISTS "idempotency_key",
  DROP COLUMN IF EXISTS "started_at",
  DROP COLUMN IF EXISTS "completed_at",
  DROP COLUMN IF EXISTS "cancelled_at";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_import_row_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
