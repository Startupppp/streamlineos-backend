SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD COLUMN "headcount_id" integer;
ALTER TABLE "job_requisitions" ADD CONSTRAINT "fk_job_requisitions_headcount_org" FOREIGN KEY ("org_id", "headcount_id") REFERENCES "headcount_requests"("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "job_requisitions" VALIDATE CONSTRAINT "fk_job_requisitions_headcount_org";
CREATE INDEX IF NOT EXISTS "idx_requisitions_headcount" ON "job_requisitions" ("org_id", "headcount_id");
