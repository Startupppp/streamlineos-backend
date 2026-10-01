SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  DROP CONSTRAINT IF EXISTS "fk_project_webhooks_integrations_endpoint";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_project_webhooks_integrations_endpoint_id";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  DROP COLUMN IF EXISTS "integrations_endpoint_id";
