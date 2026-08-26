-- 0490 — provider_webhook_events
-- =============================================================================
-- Tickets: c17-01 (record provider event before acting), c17-02 (ack only durable work)
--
-- Every inbound webhook is recorded here, keyed by the provider's own event id,
-- BEFORE any business logic runs. A duplicate providerEventId is a no-op by
-- construction (ON CONFLICT DO NOTHING on the unique index). processedAt is
-- stamped when all side effects for the event have committed.
--
-- Safe to apply online: the table is new, no existing data or FKs depend on it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "provider_webhook_events" (
  "id"                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id"            text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider"          varchar(50) NOT NULL,
  "provider_event_id" varchar(255) NOT NULL,
  "event_type"        varchar(100) NOT NULL,
  "raw_payload"       jsonb NOT NULL,
  "processed_at"      timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "provider_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'provider_webhook_events'
      AND policyname = 'provider_webhook_events_tenant_isolation'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY provider_webhook_events_tenant_isolation
        ON provider_webhook_events
        USING (org_id = app.current_org_id())
    $policy$;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_webhook_events_provider_event"
  ON "provider_webhook_events" ("provider", "provider_event_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_provider_webhook_events_org_created"
  ON "provider_webhook_events" ("org_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_provider_webhook_events_unprocessed"
  ON "provider_webhook_events" ("org_id", "created_at")
  WHERE processed_at IS NULL;
