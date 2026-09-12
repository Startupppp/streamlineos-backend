-- 1099 — INV-26. A courier account per tenant, and the failures that account has.
-- =============================================================================
-- Three things, in the order the ticket needs them.
--
-- **(1) Somewhere to put a credential.** `inv_carriers` had four business
-- columns — name, code, tracking_url_template, is_active — and no credential,
-- which is why INV-26 sat blocked. The earlier note on the ticket said the gap
-- was a missing environment variable; that was structurally wrong and would
-- have led to the wrong build. This table is org-scoped (`org_id` +
-- `uniq_inv_carriers_org_code`), so each tenant defines its own couriers and
-- holds its own courier account. A deployment-wide variable would give every
-- tenant the same login, and would make "revoke this customer's carrier key" a
-- redeploy. The credential therefore lives on the row, encrypted at rest with
-- the same AES-256-GCM helper `workflow_secrets` uses.
--
-- `transport` is separate from `code` on purpose. `code` is the tenant's own
-- string and is never a route: an organisation naming its courier "FEDEX" must
-- not thereby acquire a FedEx integration. `transport` is written by an
-- administrator from the set the adapter registry actually knows, and NULL —
-- what every existing row gets — means no adapter, which is manual tracking and
-- a real way to run a warehouse.
--
-- **(2) Outbound failures, on the record.** `inv_carrier_operations` is one row
-- per call we make to a courier: book, label, track. Append-only, because a
-- booking that failed at 06:00 and succeeded at 06:05 is two facts and the
-- first one is why the second exists. `outcome` is three-way rather than a
-- boolean for the reason the e-invoice transport gives: `rejected` is the
-- carrier reading the request and refusing it, `unavailable` is the carrier not
-- answering at all, and treating them alike either retries a refusal forever or
-- abandons a good shipment on a timeout.
--
-- **(3) Inbound callbacks, deduplicated.** `inv_carrier_webhook_deliveries` is
-- one row per verified callback, unique on `(org_id, carrier_id, event_key)`.
-- That unique index IS the idempotency mechanism — `ON CONFLICT DO NOTHING`
-- against it, never a read-then-write check, because couriers redeliver as a
-- matter of course and two simultaneous deliveries of one event would both pass
-- a check. A callback naming a tracking number this tenant does not have is
-- stored `dead_lettered` with a reason rather than dropped.
--
-- A delivery that FAILS verification gets no row. It bumps
-- `webhook_last_failure_at` / `webhook_failure_reason` on the carrier instead.
-- The ingest is a public URL: if a bad signature could open a row, anyone who
-- can reach it could fill this table. Two columns on a row that already exists
-- are bounded and still visible to the operator, which is what the ticket asks
-- for.
--
-- Locking, per §3 Migrations. The `ALTER TABLE … ADD COLUMN` calls are all
-- nullable with no default, so each is a catalogue-only change and takes its
-- ACCESS EXCLUSIVE for microseconds; `lock_timeout` still makes a contended one
-- fail fast rather than queue every read of `inv_carriers` behind it. The two
-- new tables are empty at creation, so their foreign keys are added NOT VALID
-- and validated in the same breath — the scan has nothing to read — and the
-- indexes are built in the plain form because drizzle's runner wraps each
-- migration in one transaction and CREATE INDEX CONCURRENTLY cannot appear in
-- one.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "transport" text;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "api_base_url" text;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "api_credential_encrypted" text;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "api_credential_hint" text;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "webhook_secret_encrypted" text;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "webhook_last_failure_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD COLUMN IF NOT EXISTS "webhook_failure_reason" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_carrier_operations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "carrier_id" integer NOT NULL,
  "shipment_id" integer NOT NULL,
  "transport" text NOT NULL,
  "operation" text NOT NULL,
  "outcome" text NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "carrier_reference" text,
  "tracking_number" text,
  "label_url" text,
  "label_format" text,
  "error_code" text,
  "error_message" text,
  "requested_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_carrier_operations_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_carrier_webhook_deliveries" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "carrier_id" integer NOT NULL,
  "event_key" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "tracking_number" text,
  "shipment_id" integer,
  "payload" jsonb,
  "received_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_carrier_webhook_deliveries_org_id" UNIQUE ("org_id", "id"),
  -- The idempotency key. A redelivered callback conflicts here and applies
  -- nothing; see the receiver's ON CONFLICT DO NOTHING.
  CONSTRAINT "uniq_inv_carrier_webhook_deliveries_event" UNIQUE ("org_id", "carrier_id", "event_key")
);
--> statement-breakpoint

-- Guarded DO block so a re-run is a no-op rather than a duplicate-object error:
-- `ADD CONSTRAINT` has no `IF NOT EXISTS`.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_carrier_operations', 'fk_inv_carrier_operations_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      -- CASCADE on both composite keys rather than SET NULL. A bare
      -- `SET NULL` on a two-column key nulls `org_id` too and aborts the
      -- delete; and an operation describing a shipment that no longer exists
      -- describes nothing, so it goes with it.
      ('inv_carrier_operations', 'fk_inv_carrier_operations_carrier_id_org', '("org_id", "carrier_id") REFERENCES "inv_carriers" ("org_id", "id") ON DELETE CASCADE'),
      ('inv_carrier_operations', 'fk_inv_carrier_operations_shipment_id_org', '("org_id", "shipment_id") REFERENCES "inv_shipments" ("org_id", "id") ON DELETE CASCADE'),
      ('inv_carrier_operations', 'fk_inv_carrier_operations_requested_by', '("requested_by") REFERENCES "users" ("id")'),
      ('inv_carrier_webhook_deliveries', 'fk_inv_carrier_webhook_deliveries_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_carrier_webhook_deliveries', 'fk_inv_carrier_webhook_deliveries_carrier_id_org', '("org_id", "carrier_id") REFERENCES "inv_carriers" ("org_id", "id") ON DELETE CASCADE'),
      -- MATCH SIMPLE, so a dead letter — which by definition names no shipment
      -- — passes the pair on a NULL rather than needing an exemption.
      ('inv_carrier_webhook_deliveries', 'fk_inv_carrier_webhook_deliveries_shipment_id_org', '("org_id", "shipment_id") REFERENCES "inv_shipments" ("org_id", "id") ON DELETE CASCADE')
    ) AS t(tbl, name, spec)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = fk.name AND conrelid = fk.tbl::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID', fk.tbl, fk.name, fk.spec
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = fk.name AND conrelid = fk.tbl::regclass AND NOT convalidated
    ) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tbl, fk.name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- The vocabularies, in the database rather than only in a Zod schema. A writer
-- that bypasses the service — a repair script, a future consumer — must not be
-- able to invent a fourth outcome that no reader knows how to render.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_carrier_operations_vocabulary'
  ) THEN
    ALTER TABLE "inv_carrier_operations"
      ADD CONSTRAINT "chk_inv_carrier_operations_vocabulary" CHECK (
        "operation" IN ('book', 'label', 'track')
        AND "outcome" IN ('accepted', 'rejected', 'unavailable')
        AND "attempts" >= 1
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_carrier_webhook_deliveries_status'
  ) THEN
    ALTER TABLE "inv_carrier_webhook_deliveries"
      ADD CONSTRAINT "chk_inv_carrier_webhook_deliveries_status" CHECK (
        "status" IN ('applied', 'ignored', 'dead_lettered')
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_carrier_operations" VALIDATE CONSTRAINT "chk_inv_carrier_operations_vocabulary";
--> statement-breakpoint
ALTER TABLE "inv_carrier_webhook_deliveries" VALIDATE CONSTRAINT "chk_inv_carrier_webhook_deliveries_status";
--> statement-breakpoint

-- "What has this shipment's carrier done", newest first — the shipment sheet.
CREATE INDEX IF NOT EXISTS "idx_inv_carrier_operations_org_shipment"
  ON "inv_carrier_operations" ("org_id", "shipment_id", "created_at" DESC);
--> statement-breakpoint

-- "What is broken right now" — the operator's queue. Leads with `org_id`
-- because RLS adds `org_id = app.current_org_id()` to every read here, and an
-- index that does not supply `org_id` itself can never serve an index-only
-- scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_carrier_operations_org_outcome"
  ON "inv_carrier_operations" ("org_id", "outcome", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_carrier_webhook_deliveries_org_status"
  ON "inv_carrier_webhook_deliveries" ("org_id", "status", "received_at" DESC);
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants
-- to `streamline_app` arrive through ALTER DEFAULT PRIVILEGES, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this is part of the migration that creates them.
ALTER TABLE "inv_carrier_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_carrier_operations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_carrier_operations"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_carrier_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_carrier_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_carrier_webhook_deliveries"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
