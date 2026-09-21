
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" DROP NOT NULL;
