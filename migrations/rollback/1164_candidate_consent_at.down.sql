SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "candidate_applications" DROP COLUMN IF EXISTS "consent_at";
