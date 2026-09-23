SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "consent_at" timestamp;
