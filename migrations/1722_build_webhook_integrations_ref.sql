SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  ADD COLUMN IF NOT EXISTS "integrations_endpoint_id" INTEGER;
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  ADD CONSTRAINT "fk_project_webhooks_integrations_endpoint"
  FOREIGN KEY ("integrations_endpoint_id")
  REFERENCES "integration_webhook_endpoint_credentials"("id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  VALIDATE CONSTRAINT "fk_project_webhooks_integrations_endpoint";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_webhooks_integrations_endpoint_id"
  ON "build"."project_webhooks" ("integrations_endpoint_id")
  WHERE "integrations_endpoint_id" IS NOT NULL;
