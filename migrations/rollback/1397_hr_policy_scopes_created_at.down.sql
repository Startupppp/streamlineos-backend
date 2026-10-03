SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "hr_policy_scopes" DROP COLUMN IF EXISTS "created_at";
