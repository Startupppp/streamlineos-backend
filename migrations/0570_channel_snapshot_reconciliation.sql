-- 0570 — E6. Channel snapshot reconciliation: what a marketplace posted at us,
-- and where we write down that it disagrees with our ledger.
--
-- ## What is real here, and what is not
--
-- No Shopify, Amazon or WooCommerce store is connected. There is no OAuth, no
-- token, and nothing in this repository has ever fetched a real channel's
-- inventory levels. What exists is a *boundary*: a signature scheme we can
-- verify, a delivery table that makes a duplicate a no-op, and a difference
-- table. The only adapter registered at runtime is a fake behind
-- `INV_CHANNEL_ADAPTER=fake`.
--
-- ## Why neither table is a ledger
--
-- E6's hardest requirement is that a snapshot cannot drive a `quantity_change`
-- by itself. A marketplace telling us it has 7 of something is that
-- marketplace's opinion about our stock; it is evidence, not a movement. So the
-- refetch path writes a *difference* and stops. Posting is a separate, ordinary
-- stock-engine command issued by a named operator under their own warehouse
-- scope, which is why `stock_transaction_id` is nullable here and set only after
-- somebody accepts.
--
-- ## Locking, per §3 Migrations
--
-- Both tables are new, so nothing blocks a read of them — but their foreign keys
-- point at live tables and a bare `ADD CONSTRAINT … FOREIGN KEY` takes ACCESS
-- EXCLUSIVE on BOTH sides for the validating scan. `organizations` and `users`
-- are shared by every tenant, so each FK is added `NOT VALID` and validated
-- separately, and `lock_timeout` makes a contended one fail fast rather than
-- queue every write behind it. Indexes are the plain form because the runner
-- wraps a pending migration in one transaction and `CREATE INDEX CONCURRENTLY`
-- cannot appear inside one; the tables are empty at creation, so that is
-- instantaneous rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

-- PENDING is "received, not yet refetched". DEAD is a delivery whose refetch has
-- failed its whole ladder — kept rather than deleted, because "the marketplace
-- told us something and we never looked" is exactly the fact an operator needs.
DO $$ BEGIN
  CREATE TYPE "inv_channel_delivery_status" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'DEAD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_channel_snapshot_diff_status" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- RECORD_DIFFERENCE is the default and the one E6 calls "usually": the
-- difference is written down and nothing moves. ALLOW_ADJUSTMENT does not mean
-- "the snapshot writes the ledger" — it means an operator is *permitted* to
-- accept a difference, which then posts one ordinary stock-engine command under
-- their own name, idempotency key and warehouse scope.
DO $$ BEGIN
  CREATE TYPE "inv_channel_snapshot_policy" AS ENUM ('RECORD_DIFFERENCE', 'ALLOW_ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- E6. What a channel posted at us, and the fence that makes a duplicate
-- delivery a no-op.
--
-- The raw body is deliberately NOT kept — a marketplace payload carries a
-- customer's name and address, and this table exists to answer "did we already
-- handle delivery X", not to be a second copy of somebody's order book. The
-- digest is enough to show that two deliveries carrying the same id really were
-- the same bytes.
CREATE TABLE IF NOT EXISTS "inv_channel_webhook_deliveries" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "provider_delivery_id" text NOT NULL,
  "topic" text NOT NULL,
  "external_ref" text,
  "status" "inv_channel_delivery_status" DEFAULT 'PENDING' NOT NULL,
  "payload_digest" text NOT NULL,
  "delivery_metadata" jsonb,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "lease_expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_channel_webhook_deliveries_org_id" UNIQUE ("org_id", "id"),
  -- E6's done-when, as a constraint rather than a convention: a channel that
  -- retries a delivery it already sent inserts nothing, so the refetch runs once
  -- and one delivery cannot become two of anything downstream.
  CONSTRAINT "uniq_inv_channel_delivery" UNIQUE ("org_id", "channel_id", "provider_delivery_id")
);
--> statement-breakpoint

-- E6. The channel and the ledger disagree, written down.
--
-- `product_variant_id` is nullable on purpose: a channel SKU that matches
-- nothing of ours is the single most common real finding, and dropping those
-- rows would turn the most useful signal this table produces into silence.
-- `external_sku` is therefore the identity and the variant is the resolution.
CREATE TABLE IF NOT EXISTS "inv_channel_snapshot_diffs" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "delivery_id" integer,
  "product_variant_id" integer,
  "external_sku" text NOT NULL,
  "channel_qty" numeric(18, 4) NOT NULL,
  "internal_qty" numeric(18, 4) NOT NULL,
  "difference" numeric(18, 4) NOT NULL,
  "status" "inv_channel_snapshot_diff_status" DEFAULT 'OPEN' NOT NULL,
  "snapshot_at" timestamp NOT NULL,
  "resolved_by" text,
  "resolved_at" timestamp,
  "resolution_note" text,
  "stock_transaction_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_channel_snapshot_diffs_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

-- One OPEN difference per channel SKU, so a refetch that finds the same
-- disagreement updates it rather than adding to a pile. This is the second half
-- of "a duplicate delivery creates nothing twice": even a delivery that *does*
-- get through twice — a different delivery id for the same event, which no
-- fence can catch — converges on one row rather than two. Resolved rows are
-- kept: what a marketplace claimed is the evidence behind the adjustment
-- somebody eventually posted.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_channel_snapshot_diff_open"
  ON "inv_channel_snapshot_diffs" ("org_id", "channel_id", "external_sku")
  WHERE "status" = 'OPEN';
--> statement-breakpoint

-- E6. The operator policy, per channel, defaulting to the safe answer.
ALTER TABLE "inv_channels"
  ADD COLUMN IF NOT EXISTS "snapshot_policy" "inv_channel_snapshot_policy"
  DEFAULT 'RECORD_DIFFERENCE' NOT NULL;
--> statement-breakpoint

-- Where an accepted difference would post. Nullable, and ALLOW_ADJUSTMENT
-- without it refuses rather than guessing — a channel names warehouses, and a
-- warehouse is not a place stock can sit.
ALTER TABLE "inv_channels"
  ADD COLUMN IF NOT EXISTS "reconciliation_location_id" integer;
--> statement-breakpoint

-- Guarded DO block so a re-run is a no-op rather than a duplicate-object error:
-- `ADD CONSTRAINT` has no `IF NOT EXISTS`.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_channel_webhook_deliveries', 'fk_inv_channel_deliveries_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_channel_webhook_deliveries', 'fk_inv_channel_deliveries_channel', '("channel_id") REFERENCES "inv_channels" ("id") ON DELETE CASCADE'),
      ('inv_channel_webhook_deliveries', 'fk_inv_channel_deliveries_channel_org', '("org_id", "channel_id") REFERENCES "inv_channels" ("org_id", "id")'),

      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_channel', '("channel_id") REFERENCES "inv_channels" ("id") ON DELETE CASCADE'),
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_channel_org', '("org_id", "channel_id") REFERENCES "inv_channels" ("org_id", "id")'),
      -- MATCH SIMPLE, so an unmatched channel SKU — the null variant — passes
      -- the composite pair rather than needing an exemption. Same for a diff
      -- produced by a scheduled refetch, which names no delivery, and for one
      -- nobody has accepted, which names no stock transaction.
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_variant_org', '("org_id", "product_variant_id") REFERENCES "inv_product_variants" ("org_id", "id")'),
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_delivery_org', '("org_id", "delivery_id") REFERENCES "inv_channel_webhook_deliveries" ("org_id", "id")'),
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_txn_org', '("org_id", "stock_transaction_id") REFERENCES "inv_stock_transactions" ("org_id", "id")'),
      ('inv_channel_snapshot_diffs', 'fk_inv_channel_diffs_resolved_by', '("resolved_by") REFERENCES "users" ("id")'),

      ('inv_channels', 'fk_inv_channels_reconciliation_location_org', '("org_id", "reconciliation_location_id") REFERENCES "inv_locations" ("org_id", "id")')
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

-- `difference` is `channel_qty - internal_qty` and nothing else. Storing it
-- rather than computing it on read is what lets an operator sort by size of
-- disagreement on an index; the constraint is what stops it drifting from the
-- two numbers it claims to be derived from.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_channel_diffs_difference'
  ) THEN
    ALTER TABLE "inv_channel_snapshot_diffs"
      ADD CONSTRAINT "chk_inv_channel_diffs_difference"
      CHECK ("difference" = "channel_qty" - "internal_qty") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_channel_snapshot_diffs" VALIDATE CONSTRAINT "chk_inv_channel_diffs_difference";
--> statement-breakpoint

-- A resolved difference names who resolved it and when. Without this a row can
-- claim ACCEPTED with nobody's name against it, which is the audit trail
-- quietly not being one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_channel_diffs_resolution'
  ) THEN
    ALTER TABLE "inv_channel_snapshot_diffs"
      ADD CONSTRAINT "chk_inv_channel_diffs_resolution" CHECK (
        "status" = 'OPEN'
        OR ("resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_channel_snapshot_diffs" VALIDATE CONSTRAINT "chk_inv_channel_diffs_resolution";
--> statement-breakpoint

-- The drain query: oldest PENDING delivery per organisation. Leads with `org_id`
-- because RLS adds `org_id = app.current_org_id()` to every read here, and an
-- index that does not supply `org_id` itself can never serve an index-only scan
-- (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_channel_deliveries_org_status"
  ON "inv_channel_webhook_deliveries" ("org_id", "status", "received_at");
--> statement-breakpoint

-- "What is still open on this channel" — the read behind the reconciliation
-- screen.
CREATE INDEX IF NOT EXISTS "idx_inv_channel_diffs_org_channel_status"
  ON "inv_channel_snapshot_diffs" ("org_id", "channel_id", "status", "snapshot_at" DESC);
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants
-- to `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this is part of the migration that creates them rather than a
-- follow-up.
ALTER TABLE "inv_channel_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_channel_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_channel_webhook_deliveries"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_channel_snapshot_diffs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_channel_snapshot_diffs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_channel_snapshot_diffs"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- E6 — how an inbound channel delivery finds its tenant, in the same shape as
-- 0387's git resolver and for the same reason.
--
-- `POST /inventory/channels/inbound/:channelId` is `@Public()`: the caller is a
-- marketplace with no session, so `TenantContextInterceptor` opens no
-- transaction and there is no `app.current_org_id()`. The handler therefore
-- cannot read `inv_channels` at all — the policy above fails closed with 42501 —
-- and cannot open a tenant transaction either, because it does not yet know
-- which tenant. Something has to break that circle.
--
-- A policy arm on `inv_channels` keyed on `id` would grant blanket read of the
-- WHOLE row to any future id-only query, including `settings`, which is where a
-- store's configuration lives. This returns the org id and nothing else, so the
-- widening is one column wide.
--
-- The channel id is a serial and therefore guessable. That is deliberate and
-- safe: the id is not the security boundary. The HMAC over the raw body,
-- verified against a deployment secret AFTER this lookup, is — and a caller who
-- cannot produce that signature gets 401 whatever id they guessed. What an
-- unauthenticated guesser can learn from this function alone is nothing: it is
-- never called with a caller-visible result, only to choose which tenant's
-- transaction to open.
CREATE OR REPLACE FUNCTION app.resolve_inv_channel_org_id(p_channel_id integer) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM inv_channels WHERE id = p_channel_id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_inv_channel_org_id(integer) IS
  'Returns only the org_id for a sales channel, bypassing RLS for that single column so an inbound channel webhook can resolve its tenant before verifying the request signature. Never expose any other channel column (esp. settings) through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_inv_channel_org_id(integer) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_inv_channel_org_id(integer) TO %I', app_role);
  END IF;
END $$;
