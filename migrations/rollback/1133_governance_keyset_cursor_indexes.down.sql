SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_risks_org_project_id_desc";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_decisions_org_project_id_desc";
