SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_talent_pools_tags";
--> statement-breakpoint
ALTER TABLE "talent_pools" DROP COLUMN IF EXISTS "tags";
