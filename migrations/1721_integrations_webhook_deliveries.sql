SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_webhook_deliveries" (
  "id"              BIGSERIAL PRIMARY KEY,
  "org_id"          TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "credential_id"   INTEGER,
  "build_webhook_id" INTEGER,
  "target_url"      TEXT NOT NULL,
  "event"           VARCHAR(100) NOT NULL,
  "payload"         JSONB,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'pending',
  "response_code"   INTEGER,
  "response_body"   TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "next_attempt_at" TIMESTAMP WITH TIME ZONE,
  "delivered_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT "chk_integration_webhook_deliveries_status"
    CHECK ("status" IN ('pending', 'success', 'failed')),
  CONSTRAINT "fk_int_wh_deliveries_credential"
    FOREIGN KEY ("credential_id")
    REFERENCES "integration_webhook_endpoint_credentials"("id")
    ON DELETE SET NULL NOT VALID
);
--> statement-breakpoint

ALTER TABLE "integration_webhook_deliveries"
  VALIDATE CONSTRAINT "fk_int_wh_deliveries_credential";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_webhook_deliveries_credential"
  ON "integration_webhook_deliveries" ("org_id", "credential_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_webhook_deliveries_build_webhook"
  ON "integration_webhook_deliveries" ("org_id", "build_webhook_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_webhook_deliveries_delivered_at"
  ON "integration_webhook_deliveries" ("delivered_at");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_integration_webhook_deliveries_org_id"
  ON "integration_webhook_deliveries" ("org_id", "id");
--> statement-breakpoint

ALTER TABLE "integration_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "integration_webhook_deliveries";
CREATE POLICY tenant_isolation ON "integration_webhook_deliveries"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_webhook_deliveries" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'integration_webhook_deliveries'
  ), 'integration_webhook_deliveries table not created';
END $$;
