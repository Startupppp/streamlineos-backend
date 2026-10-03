SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP CONSTRAINT IF EXISTS "chk_candidate_offers_ctc_non_negative";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_gratuity";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_employer_pf";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_equity_value";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_joining_bonus";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_variable";
--> statement-breakpoint
ALTER TABLE "candidate_offers" DROP COLUMN IF EXISTS "ctc_fixed";
