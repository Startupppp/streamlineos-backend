SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."git_connections" ALTER COLUMN "webhook_secret" SET NOT NULL;
--> statement-breakpoint

DROP TABLE IF EXISTS "integration_git_connection_credentials";
