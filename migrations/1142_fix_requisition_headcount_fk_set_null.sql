
SET lock_timeout = '5s';
--> statement-breakpoint

-- fk_job_requisitions_headcount_org was authored in 1128a without a column list.
-- ON DELETE SET NULL with no column list writes NULL to every constrained column,
-- including org_id which is NOT NULL. Deleting a headcount_requests row raises 23502.
-- The fix is an explicit (headcount_id) column list so only the nullable column is
-- nulled on parent delete. Pattern mirrors 0992_set_null_referential_actions_repair.sql.

ALTER TABLE "job_requisitions"
  DROP CONSTRAINT "fk_job_requisitions_headcount_org";
--> statement-breakpoint

ALTER TABLE "job_requisitions"
  ADD CONSTRAINT "fk_job_requisitions_headcount_org"
  FOREIGN KEY ("org_id", "headcount_id")
  REFERENCES "headcount_requests"("org_id", "id")
  ON DELETE SET NULL ("headcount_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "job_requisitions" VALIDATE CONSTRAINT "fk_job_requisitions_headcount_org";
