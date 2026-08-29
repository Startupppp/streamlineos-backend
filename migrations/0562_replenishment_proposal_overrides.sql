-- 0562 — C2. A person overruling the engine, on the record.
--
-- C1 persisted the forecast; C6 made the purchase-order quantity the server's,
-- re-derived from the stored proposal against the live position. This migration
-- closes the last hole in that claim, which is not a hole in the arithmetic but
-- in the vocabulary: there was no way for a buyer who genuinely knows better to
-- say so. Without one, the pressure goes somewhere — into a hand-raised order,
-- or into editing the draft afterwards — and either way the number that reaches
-- the supplier stops being traceable to anything.
--
-- `inv_proposal_overrides` gives that act a name. It records which stored
-- proposal was overruled, what the engine would have ordered, what the person
-- asked for, what actually went on the line, why, who, and which order it
-- became. None of those survive in `inv_po_lines`, which keeps only the number
-- that won and no account of whose it was.
--
-- Two columns rather than one for the person's figure — `requested_qty` and
-- `ordered_qty` — because the supplier's minimum and pack size are applied to an
-- override as well. A buyer asking for 30 against a case of 12 buys 36, and that
-- difference is the policy's doing, not theirs. Collapsing the two would put the
-- policy's rounding on the person's account.
--
-- Append-only, like the forecasts it annotates. An override is a historical act;
-- editing one rewrites the reason a purchase order exists, which is precisely
-- the evidence this table was added to keep.
--
-- Locking, per §3 Migrations. The table is new, so nothing here blocks a read of
-- it — but its foreign keys point at live tables, and a bare `ADD CONSTRAINT …
-- FOREIGN KEY` takes ACCESS EXCLUSIVE on BOTH sides for the validating scan.
-- `users` is global: every tenant's authentication would queue behind it. So
-- each FK is added `NOT VALID` and validated separately, and `lock_timeout`
-- makes a contended one fail fast instead of blocking the queue behind it. The
-- indexes are the plain form because drizzle's runner wraps each pending
-- migration in one transaction and `CREATE INDEX CONCURRENTLY` cannot appear
-- inside a transaction block; the table is empty at creation, so the plain build
-- is instantaneous rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_proposal_overrides" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "forecast_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "warehouse_id" integer,

  "engine_qty" numeric(18, 4) NOT NULL,
  "requested_qty" numeric(18, 4) NOT NULL,
  "ordered_qty" numeric(18, 4) NOT NULL,
  "reason" text NOT NULL,

  "po_id" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_proposal_overrides_org_id" UNIQUE ("org_id", "id")
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
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      -- The proposal is what the override overruled. If the forecast history is
      -- gone the override describes nothing, so it goes with it.
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_forecast', '("forecast_id") REFERENCES "inv_demand_forecasts" ("id") ON DELETE CASCADE'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_warehouse', '("warehouse_id") REFERENCES "inv_warehouses" ("id") ON DELETE CASCADE'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_po', '("po_id") REFERENCES "inv_purchase_orders" ("id") ON DELETE CASCADE'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_created_by', '("created_by") REFERENCES "users" ("id")'),
      -- The composite tenant keys. MATCH SIMPLE, so a NULL warehouse_id — the
      -- org-wide scope — passes the pair rather than needing an exemption.
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_forecast_org', '("org_id", "forecast_id") REFERENCES "inv_demand_forecasts" ("org_id", "id")'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_variant_org', '("org_id", "product_variant_id") REFERENCES "inv_product_variants" ("org_id", "id")'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_warehouse_org', '("org_id", "warehouse_id") REFERENCES "inv_warehouses" ("org_id", "id")'),
      ('inv_proposal_overrides', 'fk_inv_proposal_overrides_po_org', '("org_id", "po_id") REFERENCES "inv_purchase_orders" ("org_id", "id")')
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

-- An override with no reason is a silent replacement of the engine's number,
-- which is the exact thing this table exists to make impossible. A whitespace
-- reason is no reason, so the length is measured after trimming. Quantities are
-- positive: an override to zero is a decision not to order, and that is
-- expressed by leaving the proposal out of the batch rather than by ordering
-- nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_proposal_overrides_reason'
  ) THEN
    ALTER TABLE "inv_proposal_overrides"
      ADD CONSTRAINT "chk_inv_proposal_overrides_reason" CHECK (
        char_length(btrim("reason")) >= 10
        AND "engine_qty" >= 0
        AND "requested_qty" > 0
        AND "ordered_qty" > 0
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_proposal_overrides" VALIDATE CONSTRAINT "chk_inv_proposal_overrides_reason";
--> statement-breakpoint

-- "Has this proposal ever been overruled, and when" — the read behind the
-- override history on a proposal. Leads with `org_id` because RLS adds
-- `org_id = app.current_org_id()` to every read here, and an index that does not
-- supply `org_id` itself can never serve an index-only scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_proposal_overrides_org_forecast"
  ON "inv_proposal_overrides" ("org_id", "forecast_id", "created_at" DESC);
--> statement-breakpoint

-- "Which lines on this purchase order came from a person rather than the
-- engine" — the read a buyer does while looking at the draft.
CREATE INDEX IF NOT EXISTS "idx_inv_proposal_overrides_org_po"
  ON "inv_proposal_overrides" ("org_id", "po_id");
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants
-- to `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this block is part of the migration that creates it rather than a
-- follow-up.
ALTER TABLE "inv_proposal_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_proposal_overrides";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_proposal_overrides"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
