SET lock_timeout='5s';
--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "invited_by" DROP NOT NULL;
