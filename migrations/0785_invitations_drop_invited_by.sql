SET lock_timeout='5s';
--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "invited_by";
