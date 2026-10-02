SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO "integration_git_connection_credentials" (
  "org_id",
  "git_connection_id",
  "signing_secret",
  "secret_set_at",
  "created_at"
)
SELECT
  gc."org_id",
  gc."id",
  gc."webhook_secret",
  gc."created_at",
  gc."created_at"
FROM "build"."git_connections" gc
WHERE gc."webhook_secret" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE "build"."git_connections" DROP COLUMN IF EXISTS "webhook_secret";
