SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO "integration_webhook_deliveries" (
  "org_id",
  "credential_id",
  "build_webhook_id",
  "target_url",
  "event",
  "payload",
  "status",
  "response_code",
  "response_body",
  "attempts",
  "last_error",
  "next_attempt_at",
  "created_at",
  "delivered_at"
)
SELECT
  d."org_id",
  cred."id"                 AS credential_id,
  d."webhook_id"            AS build_webhook_id,
  pw."url"                  AS target_url,
  d."event",
  d."payload",
  d."status",
  d."response_code",
  d."response_body",
  d."attempts",
  d."last_error",
  d."next_attempt_at",
  d."delivered_at"          AS created_at,
  CASE WHEN d."status" = 'success' THEN d."delivered_at" ELSE NULL END AS delivered_at
FROM "build"."webhook_deliveries" d
JOIN "build"."project_webhooks" pw
  ON pw."id" = d."webhook_id"
 AND pw."org_id" = d."org_id"
LEFT JOIN "integration_webhook_endpoint_credentials" cred
  ON cred."build_webhook_id" = d."webhook_id"
 AND cred."org_id" = d."org_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  old_count  BIGINT;
  new_count  BIGINT;
BEGIN
  SELECT COUNT(*) INTO old_count FROM "build"."webhook_deliveries";
  SELECT COUNT(*) INTO new_count
    FROM "integration_webhook_deliveries"
   WHERE "build_webhook_id" IS NOT NULL;
  ASSERT new_count >= old_count,
    format('Backfill incomplete: %s old rows but only %s new rows with build_webhook_id set', old_count, new_count);
END $$;
