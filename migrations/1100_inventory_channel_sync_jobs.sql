-- 1100 — INV-27. The channel work queue, and the dead-letter box it fails into.
-- =============================================================================
-- 0570 built the *inbound* half of the channel boundary: a signature scheme, a
-- delivery table whose unique `(org, channel, provider_delivery_id)` makes a
-- duplicate a no-op, and a difference table. What it did not build is the half
-- where we initiate: pushing availability to a marketplace, pulling its orders
-- in, telling it a parcel shipped. INV-27 is that half, and this is the one
-- table it needs.
--
-- ## Why a second queue rather than a column on the first
--
-- `inv_channel_webhook_deliveries` is "what a sales channel posted at us". Its
-- `received_at`, its `payload_digest` and its `provider_delivery_id` are all
-- facts about a request we did not make, and its drain worker reads every
-- PENDING row as "refetch this channel's snapshot". Putting outbound work in
-- there would have meant branching that worker on `topic` and leaving three of
-- that table's columns holding something other than what their comments claim.
--
-- What is shared is what should be: the status vocabulary
-- (`inv_channel_delivery_status` — PENDING / PROCESSED / FAILED / DEAD) and the
-- attempt ladder in `channel-adapter.ts`. One mechanism, two queues, and one
-- operator surface listing both.
--
-- ## The unique key is the feature
--
-- `uniq_inv_channel_job_ref` on (org_id, channel_id, kind, external_ref) is
-- INV-27's "re-importing the same channel order must not create a second
-- order", expressed where it cannot be forgotten. An `ORDER_IMPORT` row's
-- `external_ref` IS the marketplace's order id, so the second import of order
-- 1001 conflicts on insert and no second `inv_sales_orders` row is written. The
-- worker also re-checks `sales_order_id IS NULL` before creating one, so the
-- fence holds even if somebody resets a row by hand — but the constraint is the
-- one that survives a crash between "fetched from the channel" and "created
-- ours", which is the failure that actually produces a duplicate order.
--
-- `kind` is part of the key so that the refs do not have to be globally unique
-- across flows: order 1001 and the shipment for order 1001 are two rows.
--
-- ## `chk_inv_channel_jobs_dead_has_reason`
--
-- INV-27's acceptance is that a dead letter is *visible*, with its reason and
-- its attempt count. A DEAD row carrying a null `last_error` is that acceptance
-- failing silently, so the database refuses one rather than trusting every
-- future writer to fill it in.
--
-- ## Locking, per §3 Migrations
--
-- The table is new, so nothing blocks a read of it — but its keys point at
-- `organizations`, `users`, `inv_channels` and `inv_sales_orders`, all live and
-- shared, and a bare `ADD CONSTRAINT … FOREIGN KEY` takes ACCESS EXCLUSIVE on
-- BOTH sides for the validating scan. Every key is therefore added NOT VALID and
-- validated separately, and `lock_timeout` makes a contended one fail fast
-- rather than queue every write to those tables behind it. Indexes are the plain
-- form because the runner wraps a pending migration in one transaction and
-- `CREATE INDEX CONCURRENTLY` cannot appear inside one; the table is empty at
-- creation, so that is instantaneous rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

-- The five things a channel job can be. ORDER_PULL and ORDER_IMPORT are
-- deliberately separate: a pull is one conversation with the marketplace, an
-- import is one order becoming one of ours and is where the natural key lives.
DO $$ BEGIN
  CREATE TYPE "inv_channel_job_kind" AS ENUM ('STOCK_PUSH', 'STOCK_PULL', 'ORDER_PULL', 'ORDER_IMPORT', 'SHIP_CONFIRM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_channel_jobs" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "kind" "inv_channel_job_kind" NOT NULL,
  "external_ref" text NOT NULL,
  "status" "inv_channel_delivery_status" DEFAULT 'PENDING' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error" text,
  -- Small on purpose: what was offered and what came back, never the
  -- marketplace's payload whole. A channel order carries a customer's name and
  -- address and a retry queue is a bad place for a second copy of one.
  "request" jsonb,
  "response" jsonb,
  "sales_order_id" integer,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "lease_expires_at" timestamp,
  "processed_at" timestamp,
  "dead_lettered_at" timestamp,
  "enqueued_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_channel_jobs_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_inv_channel_job_ref" UNIQUE ("org_id", "channel_id", "kind", "external_ref")
);
--> statement-breakpoint

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('inv_channel_jobs', 'fk_inv_channel_jobs_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_channel_jobs', 'fk_inv_channel_jobs_channel', '("channel_id") REFERENCES "inv_channels" ("id") ON DELETE CASCADE'),
      ('inv_channel_jobs', 'fk_inv_channel_jobs_channel_org', '("org_id", "channel_id") REFERENCES "inv_channels" ("org_id", "id")'),
      ('inv_channel_jobs', 'fk_inv_channel_jobs_sales_order_org', '("org_id", "sales_order_id") REFERENCES "inv_sales_orders" ("org_id", "id")'),
      ('inv_channel_jobs', 'fk_inv_channel_jobs_enqueued_by', '("enqueued_by") REFERENCES "users" ("id")')
    ) AS t(tbl, name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = spec.name
         AND conrelid = format('public.%I', spec.tbl)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID',
        spec.tbl, spec.name, spec.definition
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "fk_inv_channel_jobs_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "fk_inv_channel_jobs_channel";
--> statement-breakpoint
ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "fk_inv_channel_jobs_channel_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "fk_inv_channel_jobs_sales_order_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "fk_inv_channel_jobs_enqueued_by";
--> statement-breakpoint

-- A dead letter with no reason is INV-27's acceptance failing silently.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_inv_channel_jobs_dead_has_reason'
       AND conrelid = 'public.inv_channel_jobs'::regclass
  ) THEN
    ALTER TABLE public.inv_channel_jobs
      ADD CONSTRAINT chk_inv_channel_jobs_dead_has_reason
      CHECK ("status" <> 'DEAD' OR ("last_error" IS NOT NULL AND "dead_lettered_at" IS NOT NULL))
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_channel_jobs" VALIDATE CONSTRAINT "chk_inv_channel_jobs_dead_has_reason";
--> statement-breakpoint

-- The claim: due work for one organisation, oldest first. Two equalities then
-- the inequality that is also the sort.
CREATE INDEX IF NOT EXISTS "idx_inv_channel_jobs_due"
  ON "inv_channel_jobs" ("org_id", "status", "next_attempt_at");
--> statement-breakpoint

-- "What is wrong with this channel" — the read behind the dead-letter screen.
CREATE INDEX IF NOT EXISTS "idx_inv_channel_jobs_org_channel_status"
  ON "inv_channel_jobs" ("org_id", "channel_id", "status", "created_at");
--> statement-breakpoint

-- Tenant isolation, the same shape `inv_channel_webhook_deliveries` carries and
-- for the same reason: grants to `streamline_app` arrive through
-- `ALTER DEFAULT PRIVILEGES`, so a table left without a policy is readable
-- across every organisation and nothing says so. Part of the migration that
-- creates the table rather than a follow-up.
ALTER TABLE "inv_channel_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_channel_jobs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_channel_jobs"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

COMMENT ON TABLE "inv_channel_jobs" IS
  'INV-27. Outbound/pull channel work and its dead-letter box. Unique (org_id, channel_id, kind, external_ref) is order-import idempotency: an ORDER_IMPORT row''s external_ref is the marketplace''s own order id. Inbound deliveries live in inv_channel_webhook_deliveries and share this table''s status enum and retry ladder, not its rows.';
