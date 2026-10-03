SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_interviews_transcript_retention";
--> statement-breakpoint
ALTER TABLE "interviews" DROP CONSTRAINT IF EXISTS "fk_interviews_transcript_stored_by";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript_stored_by_membership_id";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript_stored_at";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript_retain_until";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript_consent_at";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript_source";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "transcript";
