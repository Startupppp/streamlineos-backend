SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "requires_identity_verification";
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "chk_candidates_identity_last4";
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "chk_candidates_identity_status";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "identity_verified_at";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "identity_last4";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "identity_reference";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "identity_status";
