SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_teams"
  DROP COLUMN IF EXISTS "capacity";
