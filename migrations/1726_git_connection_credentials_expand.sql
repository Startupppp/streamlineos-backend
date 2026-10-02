SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_git_connection_credentials" (
  "id"               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"           TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "git_connection_id" INTEGER NOT NULL,
  "signing_secret"   TEXT NOT NULL,
  "secret_set_at"    TIMESTAMP WITH TIME ZONE NOT NULL,
  "created_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "integration_git_connection_credentials"
  DROP CONSTRAINT IF EXISTS "fk_int_git_conn_cred_org_conn";
--> statement-breakpoint

ALTER TABLE "integration_git_connection_credentials"
  ADD CONSTRAINT "fk_int_git_conn_cred_org_conn"
  FOREIGN KEY ("org_id", "git_connection_id")
  REFERENCES "build"."git_connections"("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "integration_git_connection_credentials"
  VALIDATE CONSTRAINT "fk_int_git_conn_cred_org_conn";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integration_git_conn_cred_org"
  ON "integration_git_connection_credentials" ("org_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_integration_git_conn_cred_org_id"
  ON "integration_git_connection_credentials" ("org_id", "id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_integration_git_conn_cred_org_conn"
  ON "integration_git_connection_credentials" ("org_id", "git_connection_id");
--> statement-breakpoint

ALTER TABLE "integration_git_connection_credentials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "integration_git_connection_credentials";
CREATE POLICY tenant_isolation ON "integration_git_connection_credentials"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_git_connection_credentials" TO streamline_app;
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

ALTER TABLE "build"."git_connections" ALTER COLUMN "webhook_secret" DROP NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "build"."git_connections" gc
  WHERE gc."webhook_secret" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "integration_git_connection_credentials" c
      WHERE c."org_id" = gc."org_id"
        AND c."git_connection_id" = gc."id"
    );
  ASSERT orphan_count = 0,
    format('backfill incomplete: %s git_connections rows with a secret have no credential row', orphan_count);
END $$;
