-- Rollback for migration 1121.
--
-- DATA LOSS: status_message and status_expires_at are dropped, removing any
-- custom presence statuses users have set. There is no recovery path for
-- these values once the columns are gone.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "public"."chat_user_presence" DROP COLUMN IF EXISTS "status_expires_at";
--> statement-breakpoint
ALTER TABLE "public"."chat_user_presence" DROP COLUMN IF EXISTS "status_message";
