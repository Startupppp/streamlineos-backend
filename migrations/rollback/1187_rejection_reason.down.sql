SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "chk_candidates_rejection_other_note";
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "chk_candidates_rejection_reason";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "rejection_note";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "rejection_reason";
