SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "build"."project_webhooks"
SET "integrations_endpoint_id" = NULL
WHERE "integrations_endpoint_id" IS NOT NULL;
--> statement-breakpoint

DELETE FROM "integration_webhook_endpoint_credentials"
WHERE "build_webhook_id" IS NOT NULL;
