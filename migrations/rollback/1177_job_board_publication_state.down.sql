SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_job_board_postings_org_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_job_board_postings_org_job_platform";
--> statement-breakpoint
ALTER TABLE "job_board_postings" DROP COLUMN IF EXISTS "last_synced_at";
--> statement-breakpoint
ALTER TABLE "job_board_postings" DROP COLUMN IF EXISTS "last_attempt_at";
--> statement-breakpoint
ALTER TABLE "job_board_postings" DROP COLUMN IF EXISTS "status_detail";
--> statement-breakpoint
ALTER TABLE "job_board_postings" DROP COLUMN IF EXISTS "external_posting_id";
