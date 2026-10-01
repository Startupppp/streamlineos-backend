SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO "integration_webhook_endpoint_credentials" (
  "org_id",
  "build_webhook_id",
  "signing_secret",
  "secret_set_at",
  "created_at"
)
SELECT
  pw."org_id",
  pw."id",
  pw."secret",
  COALESCE(pw."secret_set_at", pw."created_at"),
  COALESCE(pw."secret_set_at", pw."created_at")
FROM "build"."project_webhooks" pw
WHERE pw."secret" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "integration_webhook_endpoint_credentials" c
    WHERE c."org_id" = pw."org_id" AND c."build_webhook_id" = pw."id"
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

UPDATE "build"."project_webhooks" pw
SET "integrations_endpoint_id" = c."id"
FROM "integration_webhook_endpoint_credentials" c
WHERE c."org_id" = pw."org_id"
  AND c."build_webhook_id" = pw."id"
  AND pw."integrations_endpoint_id" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "build"."project_webhooks"
  WHERE "secret" IS NOT NULL
    AND "integrations_endpoint_id" IS NULL;
  ASSERT orphan_count = 0,
    format('backfill incomplete: %s project_webhooks rows with a secret have no integrations_endpoint_id', orphan_count);
END $$;
