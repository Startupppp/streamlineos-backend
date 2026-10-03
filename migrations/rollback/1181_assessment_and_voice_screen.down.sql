SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_interviews_org_external_ref";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "external_platform";
--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN IF EXISTS "external_ref";
