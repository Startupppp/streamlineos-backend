CREATE TABLE IF NOT EXISTS "external_effect_ledger" (
  "external_effect_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "producer_event_id" text NOT NULL,
  "effect_key" text NOT NULL,
  "effect_type" text NOT NULL,
  "provider_idempotency" text NOT NULL CHECK ("provider_idempotency" IN ('NONE', 'STABLE_KEY_PROPAGATED', 'PROVIDER_ENFORCED')),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED')),
  "attempt_token" text,
  "lease_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "uncertain_retry_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_external_effect_key"
  ON "external_effect_ledger" ("organization_id", "effect_key");
CREATE INDEX IF NOT EXISTS "idx_external_effect_recovery"
  ON "external_effect_ledger" ("organization_id", "state", "lease_expires_at");
CREATE INDEX IF NOT EXISTS "idx_external_effect_event"
  ON "external_effect_ledger" ("organization_id", "producer_event_id");

ALTER TABLE "external_effect_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_effect_ledger" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "external_effect_ledger";
CREATE POLICY "tenant_isolation" ON "external_effect_ledger"
  USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id());
