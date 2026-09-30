SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_tickets_org_project_deleted_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_attachments_org_project_deleted_at";
