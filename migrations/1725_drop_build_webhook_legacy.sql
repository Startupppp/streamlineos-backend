SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."webhook_deliveries";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" DROP COLUMN IF EXISTS "secret";
