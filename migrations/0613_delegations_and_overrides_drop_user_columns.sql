SET lock_timeout = '5s';

ALTER TABLE "user_delegations" DROP COLUMN IF EXISTS "delegator_id";
--> statement-breakpoint
ALTER TABLE "user_delegations" DROP COLUMN IF EXISTS "delegatee_id";
--> statement-breakpoint
ALTER TABLE "user_module_access" DROP COLUMN IF EXISTS "user_id";
