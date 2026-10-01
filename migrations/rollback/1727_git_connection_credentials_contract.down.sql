SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."git_connections"
  ADD COLUMN IF NOT EXISTS "webhook_secret" TEXT;
--> statement-breakpoint

UPDATE "build"."git_connections" gc
SET "webhook_secret" = c."signing_secret"
FROM "integration_git_connection_credentials" c
WHERE c."org_id" = gc."org_id"
  AND c."git_connection_id" = gc."id"
  AND gc."webhook_secret" IS NULL;
