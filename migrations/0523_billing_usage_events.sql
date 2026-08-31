-- 0523 — c26: Billing usage event tables
--
-- Three tables for usage metering:
--
--   billing_usage_events      — append-only raw event log. Unique on
--                               (org_id, meter_key, source_key) so duplicate
--                               ingestion is a no-op (ON CONFLICT or 23505 catch).
--
--   billing_usage_rollups     — hourly/daily aggregation projections, rebuildable
--                               from the raw events. Unique per
--                               (org_id, meter_key, granularity, period_start) so
--                               an idempotent rebuild upserts in place.
--
--   billing_usage_reservations — quota reservation records (ACTIVE / settled).
--                               A service acquires a reservation before a chargeable
--                               action and settles or cancels on outcome.
--
-- All three are tenant-scoped and require RLS.
--
-- Note on idx_billing_usage_res_expires: this index leads with expires_at, not
-- org_id. It exists for the background sweep job that expires stale reservations
-- across all orgs — a tenant-scoped query uses idx_billing_usage_res_org_meter_active
-- instead. The sweep job must set the tenant GUC before each row it processes.
--
-- Operator notes — indexes
-- ────────────────────────
-- Run CONCURRENTLY forms by hand before applying on a live table:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_usage_events_org_meter_src"
--     ON "billing_usage_events" ("org_id", "meter_key", "source_key");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_usage_events_org_meter_time"
--     ON "billing_usage_events" ("org_id", "meter_key", "occurred_at" DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_usage_events_org_occurred"
--     ON "billing_usage_events" ("org_id", "occurred_at" DESC);
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_usage_rollups_org_meter_gran_period"
--     ON "billing_usage_rollups" ("org_id", "meter_key", "granularity", "period_start");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_usage_rollups_org_meter"
--     ON "billing_usage_rollups" ("org_id", "meter_key", "period_start" DESC);
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_usage_res_org_meter_idem"
--     ON "billing_usage_reservations" ("org_id", "meter_key", "idempotency_key");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_usage_res_org_meter_active"
--     ON "billing_usage_reservations" ("org_id", "meter_key")
--     WHERE status = 'ACTIVE';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_usage_res_expires"
--     ON "billing_usage_reservations" ("expires_at")
--     WHERE status = 'ACTIVE';

SET lock_timeout = '5s';

-- ─── billing_usage_events ────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_usage_events" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"      text NOT NULL,
  "meter_key"   varchar(100) NOT NULL,
  "subject_id"  text,
  "quantity"    integer NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "source_key"  varchar(200) NOT NULL,
  "ingested_at" timestamp NOT NULL DEFAULT now(),
  "metadata"    jsonb,
  CONSTRAINT "uniq_billing_usage_events_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_usage_events"
  ADD CONSTRAINT "billing_usage_events_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_usage_events"
  VALIDATE CONSTRAINT "billing_usage_events_org_id_organizations_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_usage_events_org_meter_src"
  ON "billing_usage_events" ("org_id", "meter_key", "source_key");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_usage_events_org_meter_time"
  ON "billing_usage_events" ("org_id", "meter_key", "occurred_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_usage_events_org_occurred"
  ON "billing_usage_events" ("org_id", "occurred_at" DESC);

--> statement-breakpoint
ALTER TABLE "billing_usage_events" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_usage_events";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_usage_events"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_usage_events" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_usage_events" TO streamline_app;

-- ─── billing_usage_rollups ───────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_usage_rollups" (
  "id"             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"         text NOT NULL,
  "meter_key"      varchar(100) NOT NULL,
  "granularity"    varchar(10) NOT NULL,
  "period_start"   timestamp NOT NULL,
  "period_end"     timestamp NOT NULL,
  "total_quantity" bigint NOT NULL,
  "event_count"    integer NOT NULL,
  "rebuilt_at"     timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_usage_rollups_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_usage_rollups"
  ADD CONSTRAINT "billing_usage_rollups_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_usage_rollups"
  VALIDATE CONSTRAINT "billing_usage_rollups_org_id_organizations_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_usage_rollups_org_meter_gran_period"
  ON "billing_usage_rollups" ("org_id", "meter_key", "granularity", "period_start");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_usage_rollups_org_meter"
  ON "billing_usage_rollups" ("org_id", "meter_key", "period_start" DESC);

--> statement-breakpoint
ALTER TABLE "billing_usage_rollups" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_usage_rollups";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_usage_rollups"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_usage_rollups" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_usage_rollups" TO streamline_app;

-- ─── billing_usage_reservations ──────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_usage_reservations" (
  "id"                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"            text NOT NULL,
  "meter_key"         varchar(100) NOT NULL,
  "subject_id"        text,
  "reserved_quantity" integer NOT NULL,
  "idempotency_key"   varchar(200) NOT NULL,
  "status"            varchar(20) NOT NULL DEFAULT 'ACTIVE',
  "created_at"        timestamp NOT NULL DEFAULT now(),
  "expires_at"        timestamp NOT NULL,
  "settled_at"        timestamp,
  "settled_quantity"  integer,
  CONSTRAINT "uniq_billing_usage_reservations_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_usage_reservations"
  ADD CONSTRAINT "billing_usage_reservations_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_usage_reservations"
  VALIDATE CONSTRAINT "billing_usage_reservations_org_id_organizations_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_usage_res_org_meter_idem"
  ON "billing_usage_reservations" ("org_id", "meter_key", "idempotency_key");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_usage_res_org_meter_active"
  ON "billing_usage_reservations" ("org_id", "meter_key")
  WHERE status = 'ACTIVE';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_usage_res_expires"
  ON "billing_usage_reservations" ("expires_at")
  WHERE status = 'ACTIVE';

--> statement-breakpoint
ALTER TABLE "billing_usage_reservations" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_usage_reservations";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_usage_reservations"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_usage_reservations" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_usage_reservations" TO streamline_app;
