SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_candidate_applications_org_retain_until";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP CONSTRAINT IF EXISTS "chk_candidate_applications_retention_pair";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP CONSTRAINT IF EXISTS "chk_candidate_applications_consent_text_hash";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP CONSTRAINT IF EXISTS "chk_candidate_applications_consent_purpose";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "retain_until";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "consent_text_hash";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "consent_version";
--> statement-breakpoint
ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "consent_purpose";
