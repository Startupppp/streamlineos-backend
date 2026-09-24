SET lock_timeout = '5s';
--> statement-breakpoint
-- The id the board itself returned. `external_post_url` already held the human
-- link; nothing held the handle a status poll or an unpublish needs, so a
-- posting could never be followed up after it was created.
ALTER TABLE "job_board_postings" ADD COLUMN IF NOT EXISTS "external_posting_id" text;
--> statement-breakpoint
-- Why the row is in the status it is in: a blocked code, or the vendor's own
-- refusal. Without it a FAILED row says nothing a recruiter can act on.
ALTER TABLE "job_board_postings" ADD COLUMN IF NOT EXISTS "status_detail" text;
--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;
--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp;
--> statement-breakpoint
-- One publication row per (org, job, board). Publishing the same job to the
-- same board twice must update the attempt, never stack duplicate rows that
-- then disagree about whether the ad is live.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_board_postings_org_job_platform"
  ON "job_board_postings" ("org_id", "job_posting_id", "platform");
--> statement-breakpoint
-- The consumer claims queued work by status; without this it scans the table.
CREATE INDEX IF NOT EXISTS "idx_job_board_postings_org_status"
  ON "job_board_postings" ("org_id", "status");
