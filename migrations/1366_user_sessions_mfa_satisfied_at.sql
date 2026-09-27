SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "mfa_satisfied_at" timestamp;
