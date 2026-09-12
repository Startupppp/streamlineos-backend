-- 0541 — C1. The forecast the engine actually made, kept.
--
-- The replenishment forecast stack computed on every read and stored nothing.
-- That has two costs and they are both invisible until somebody asks a question
-- nobody could answer:
--
--   * **No accuracy over time.** "Was the forecast we made in March any good?"
--     needs March's forecast to still exist. Recomputing it from today's ledger
--     answers a different question — the ledger has since learned what happened.
--   * **No provenance.** A buyer approved a quantity; the purchase order records
--     what was bought and nothing records why, so a proposal cannot be argued
--     with after the fact.
--
-- `inv_demand_forecasts` is **append-only history, not a mutable latest-value
-- row.** The choice is forced by the first cost above: an UPDATE in place
-- destroys the only evidence of what the engine claimed before demand moved,
-- and "latest" is recoverable from history (`ORDER BY generated_at DESC LIMIT
-- 1`, served by `idx_inv_demand_forecasts_org_variant`) while history is not
-- recoverable from latest.
--
-- It does not grow one row per read, which is the usual objection to
-- append-only. `input_fingerprint` is a SHA-256 over the exact inputs — variant,
-- warehouse, window, horizon, service level, the demand series itself with its
-- censoring flags, and the lead-time observations — and
-- `uniq_inv_demand_forecasts_fingerprint` makes a repeat of the same fixture
-- land on the row that already exists. A new version appears when the inputs
-- genuinely changed, which is exactly when there is something new to remember.
-- `NULLS NOT DISTINCT` is load-bearing there: `warehouse_id IS NULL` means "the
-- whole organisation", a real scope rather than an unknown, and under the
-- default NULLS-DISTINCT rule every org-wide regeneration would insert a
-- duplicate.
--
-- **Not partitioned.** §3 asks for a triggering row count before partitioning a
-- high-volume append-only table. There is none to record: one row per (variant,
-- warehouse, changed input state) is not a stream, and partitioning would cost a
-- compound primary key — and therefore `bare id is no longer unique` — to buy
-- nothing.
--
-- Two CHECKs carry invariants the application would otherwise have to remember:
--
--   `chk_inv_demand_forecasts_applicability` — a version either commits to a
--     safety stock and a reorder point, or it refuses and says why. The middle
--     state, a refusal with no reason, is what "the forecast engine returned
--     null" looks like six months later, and it is unrepresentable here.
--   `chk_inv_demand_forecasts_censoring` — the flag and the count cannot
--     disagree, so a reader never has to decide which of the two to believe.
--
-- Locking, per §3 Migrations. The table is new, so nothing here takes a lock on
-- a table anybody is reading — but the foreign keys point at live ones
-- (`organizations`, `users`, `inv_product_variants`, `inv_warehouses`), and a
-- bare `ADD CONSTRAINT ... FOREIGN KEY` takes ACCESS EXCLUSIVE on BOTH sides for
-- the validating scan. `users` is global: every tenant's authentication would
-- queue behind it. So each FK is added `NOT VALID` and validated separately, and
-- `lock_timeout` makes a contended one fail fast rather than blocking the queue
-- behind it. The indexes are the plain form because drizzle's runner wraps every
-- pending migration in one transaction and `CREATE INDEX CONCURRENTLY` cannot
-- appear inside a transaction block; the table is empty at creation, so the
-- plain build is instantaneous rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_demand_forecasts" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "product_variant_id" integer NOT NULL,
  "warehouse_id" integer,

  "history_weeks" integer NOT NULL,
  "horizon_weeks" integer NOT NULL,
  "periods" integer NOT NULL,
  "coverage_from" date NOT NULL,
  "coverage_to" date NOT NULL,

  "method" text,
  "demand_category" text NOT NULL,
  "adi" numeric(18, 4) NOT NULL,
  "cv2" numeric(18, 4) NOT NULL,
  "season_length" integer,

  "mae" numeric(18, 4),
  "rmse" numeric(18, 4),
  "bias" numeric(18, 4),
  "mase" numeric(18, 4),

  "service_level" numeric(6, 4) NOT NULL,
  "applicable" boolean NOT NULL,
  "refusal_reason" text,
  "safety_stock" numeric(18, 4),
  "reorder_point" numeric(18, 4),
  "lead_time_demand" numeric(18, 4),
  "z" numeric(12, 6),

  "demand_mean" numeric(18, 4) NOT NULL,
  "demand_std_dev" numeric(18, 4) NOT NULL,
  "lead_time_weeks" numeric(18, 4) NOT NULL,
  "lead_time_std_dev_weeks" numeric(18, 4) NOT NULL,
  "lead_time_observations" integer NOT NULL,

  "censored_periods" integer DEFAULT 0 NOT NULL,
  "stockout_censored" boolean DEFAULT false NOT NULL,

  "assumptions" jsonb NOT NULL,
  "input_fingerprint" text NOT NULL,

  "generated_at" timestamp DEFAULT now() NOT NULL,
  "generated_by" text NOT NULL,

  CONSTRAINT "uniq_inv_demand_forecasts_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

-- Guarded DO blocks so a re-run is a no-op rather than a duplicate-object
-- error: `ADD CONSTRAINT` has no `IF NOT EXISTS`.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE'),
      -- A forecast for a warehouse that has gone is not a forecast for the
      -- organisation; CASCADE rather than SET NULL, which would silently
      -- promote a site's history into an org-wide claim it never made.
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_warehouse', '("warehouse_id") REFERENCES "inv_warehouses" ("id") ON DELETE CASCADE'),
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_generated_by', '("generated_by") REFERENCES "users" ("id")'),
      -- The composite tenant keys. MATCH SIMPLE, so a NULL warehouse_id — the
      -- org-wide scope — passes the pair rather than needing an exemption.
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_variant_org', '("org_id", "product_variant_id") REFERENCES "inv_product_variants" ("org_id", "id")'),
      ('inv_demand_forecasts', 'fk_inv_demand_forecasts_warehouse_org', '("org_id", "warehouse_id") REFERENCES "inv_warehouses" ("org_id", "id")')
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

-- A version either commits to a number or refuses and says why. "Refused, no
-- reason given" is the state that makes a stored refusal worthless, so it does
-- not exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_demand_forecasts_applicability'
  ) THEN
    ALTER TABLE "inv_demand_forecasts"
      ADD CONSTRAINT "chk_inv_demand_forecasts_applicability" CHECK (
        (
          "applicable"
          AND "safety_stock" IS NOT NULL
          AND "reorder_point" IS NOT NULL
          AND "lead_time_demand" IS NOT NULL
        )
        OR (
          NOT "applicable"
          AND "safety_stock" IS NULL
          AND "reorder_point" IS NULL
          AND "lead_time_demand" IS NULL
          AND "refusal_reason" IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_demand_forecasts" VALIDATE CONSTRAINT "chk_inv_demand_forecasts_applicability";
--> statement-breakpoint

-- The flag and the count cannot disagree; a reader never has to pick one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_demand_forecasts_censoring'
  ) THEN
    ALTER TABLE "inv_demand_forecasts"
      ADD CONSTRAINT "chk_inv_demand_forecasts_censoring" CHECK (
        "censored_periods" >= 0
        AND "censored_periods" <= "periods"
        AND "stockout_censored" = ("censored_periods" > 0)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_demand_forecasts" VALIDATE CONSTRAINT "chk_inv_demand_forecasts_censoring";
--> statement-breakpoint

-- A service level is a probability. 0 and 1 are both nonsense here: z is
-- undefined at either end, and the arithmetic would still produce a number.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_demand_forecasts_window'
  ) THEN
    ALTER TABLE "inv_demand_forecasts"
      ADD CONSTRAINT "chk_inv_demand_forecasts_window" CHECK (
        "service_level" > 0
        AND "service_level" < 1
        AND "history_weeks" > 0
        AND "horizon_weeks" > 0
        AND "periods" >= 0
        AND "coverage_to" >= "coverage_from"
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_demand_forecasts" VALIDATE CONSTRAINT "chk_inv_demand_forecasts_window";
--> statement-breakpoint

-- The idempotency key of the whole table. NULLS NOT DISTINCT because a NULL
-- warehouse means "the whole organisation" — a scope, not an unknown — and under
-- the default rule every org-wide regeneration would append a duplicate row and
-- turn this history into a read log.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_demand_forecasts_fingerprint"
  ON "inv_demand_forecasts" ("org_id", "product_variant_id", "warehouse_id", "input_fingerprint")
  NULLS NOT DISTINCT;
--> statement-breakpoint

-- The read this table exists for: "the latest forecast for this SKU at this
-- site", and the paginated history behind it. Leads with `org_id` because RLS
-- adds `org_id = app.current_org_id()` to every read here, and an index that
-- does not supply `org_id` itself can never serve an index-only scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_demand_forecasts_org_variant"
  ON "inv_demand_forecasts" ("org_id", "product_variant_id", "warehouse_id", "generated_at" DESC);
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants
-- to `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is precisely why this block is part of the migration that creates it
-- rather than a follow-up.
ALTER TABLE "inv_demand_forecasts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_demand_forecasts";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_demand_forecasts"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
