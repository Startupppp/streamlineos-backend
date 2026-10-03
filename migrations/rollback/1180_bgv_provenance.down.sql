SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_candidates_org_bgv_reference";
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT IF EXISTS "chk_candidates_bgv_source";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "bgv_reference";
--> statement-breakpoint
ALTER TABLE "candidates" DROP COLUMN IF EXISTS "bgv_source";
