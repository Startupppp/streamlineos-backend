SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_webhook_endpoint_credentials" (
  "id"               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"           TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "build_webhook_id" INTEGER,
  "signing_secret"   TEXT NOT NULL,
  "secret_set_at"    TIMESTAMP WITH TIME ZONE NOT NULL,
  "created_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_webhook_creds_org"
  ON "integration_webhook_endpoint_credentials" ("org_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_webhook_creds_org_build_webhook"
  ON "integration_webhook_endpoint_credentials" ("org_id", "build_webhook_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_integration_webhook_creds_org_id"
  ON "integration_webhook_endpoint_credentials" ("org_id", "id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_integration_webhook_creds_build_webhook"
  ON "integration_webhook_endpoint_credentials" ("org_id", "build_webhook_id")
  WHERE "build_webhook_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "integration_webhook_endpoint_credentials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "integration_webhook_endpoint_credentials";
CREATE POLICY tenant_isolation ON "integration_webhook_endpoint_credentials"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_webhook_endpoint_credentials" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'integration_webhook_endpoint_credentials'
  ), 'integration_webhook_endpoint_credentials table not created';
END $$;
