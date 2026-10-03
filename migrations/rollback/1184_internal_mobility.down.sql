SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_candidate_applications_internal_manager";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP CONSTRAINT IF EXISTS "fk_candidate_applications_internal_manager";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP CONSTRAINT IF EXISTS "chk_candidate_applications_internal_decision";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "internal_manager_notified_at";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "internal_manager_note";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "internal_manager_decided_at";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "internal_manager_decision";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "internal_manager_membership_id";
--> statement-breakpoint
ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "fk_job_postings_job_level_id_org";
--> statement-breakpoint
ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "job_level_id";
