
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."projects"
  ADD CONSTRAINT "chk_projects_pm_workspace_id_not_null"
  CHECK ("pm_workspace_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "chk_projects_pm_workspace_id_not_null";
--> statement-breakpoint
ALTER TABLE "build"."projects" ALTER COLUMN "pm_workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "build"."projects" DROP CONSTRAINT "chk_projects_pm_workspace_id_not_null";
