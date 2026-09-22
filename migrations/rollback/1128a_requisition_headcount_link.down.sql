-- Rollback for migration 1128a.
--
-- Drops the cursor index, the FK constraint, and the headcount_id column
-- from job_requisitions. The column was added as nullable with no backfill,
-- so no pre-migration data is lost; however, any headcount_id values written
-- after the forward migration was applied are permanently discarded and the
-- pre-link state of those rows cannot be restored.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_requisitions_headcount";
--> statement-breakpoint
ALTER TABLE "job_requisitions" DROP CONSTRAINT IF EXISTS "fk_job_requisitions_headcount_org";
--> statement-breakpoint
ALTER TABLE "job_requisitions" DROP COLUMN IF EXISTS "headcount_id";
