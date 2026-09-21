
SET lock_timeout = '5s';
--> statement-breakpoint

-- Restore the original (broken) constraint from 1128a. After rolling back, the
-- constraint again has no column list and will fail 23502 on headcount_requests
-- parent deletes — do not leave this state in place.

ALTER TABLE "job_requisitions"
  DROP CONSTRAINT IF EXISTS "fk_job_requisitions_headcount_org";
--> statement-breakpoint

ALTER TABLE "job_requisitions"
  ADD CONSTRAINT "fk_job_requisitions_headcount_org"
  FOREIGN KEY ("org_id", "headcount_id")
  REFERENCES "headcount_requests"("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "job_requisitions" VALIDATE CONSTRAINT "fk_job_requisitions_headcount_org";
