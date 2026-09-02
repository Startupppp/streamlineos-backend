-- 0987 DOWN — drops the column this migration added.
-- @data-loss

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "attendance" DROP COLUMN IF EXISTS "user_membership_id";
