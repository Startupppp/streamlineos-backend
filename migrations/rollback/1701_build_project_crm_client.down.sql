SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP CONSTRAINT IF EXISTS "fk_projects_org_crm_client";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_projects_crm_client";
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP COLUMN IF EXISTS "crm_client_id";
--> statement-breakpoint
