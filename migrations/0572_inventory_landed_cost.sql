-- 0572 — G5. Landed cost: freight, duty and handling reaching the cost layers.
--
-- The problem this solves is one of timing, not arithmetic. A receipt's cost is
-- decided before its ledger row exists — `MovementCostingService.plan` works it
-- out, the row is inserted already carrying it, and a BEFORE UPDATE trigger then
-- refuses any change to `unit_cost` or `total_cost` for the rest of that row's
-- life. So the invoice line is the only cost the receipt can ever have posted
-- with. The carrier's bill, the customs assessment and the handling fee arrive
-- days or weeks later, on somebody else's desk, and frequently cover several
-- receipts at once.
--
-- A landed-cost voucher is that later document. Applying one does not restate the
-- receipt's movement — it cannot, and should not: what the ledger recorded on the
-- day is a fact. It revalues the *cost layers* the receipt created, which are
-- mutable by design (`commitIssue` writes `remaining_quantity` on every issue),
-- so the next issue draws at the true cost. Where units have already left, their
-- share of the freight can no longer enter inventory and is booked as a period
-- cost against COGS instead. No stock movement is posted, so on-hand does not
-- move.
--
-- Three tables:
--
--   inv_landed_cost_vouchers      one per receipt, DRAFT until applied
--   inv_landed_cost_charges       the invoice lines, in integer minor units
--   inv_landed_cost_allocations   where every fraction went, per cost layer
--
-- The allocation table is what makes the apportionment auditable rather than
-- asserted: allocated = capitalised + expensed on every row, and the rows sum to
-- the voucher's charge total exactly, because the apportionment is a
-- largest-remainder division of integers at the 1/10000 grain the layers are kept
-- at and the leftover is given to named rows rather than dropped.
--
-- Locking, per §3 Migrations. The tables are new, so nothing here blocks a read of
-- them — but their foreign keys point at live tables (`organizations`, `users`,
-- `inv_grns`, `inv_valuation_layers`), and a bare `ADD CONSTRAINT … FOREIGN KEY`
-- takes ACCESS EXCLUSIVE on BOTH sides for the validating scan. `users` is global:
-- every tenant's authentication would queue behind it. So each is added NOT VALID
-- and validated separately, and `lock_timeout` makes a contended one fail fast
-- rather than blocking the queue behind it. The indexes are the plain form because
-- drizzle's runner wraps a migration in one transaction and `CREATE INDEX
-- CONCURRENTLY` cannot appear inside a transaction block; the tables are empty at
-- creation, so the plain build is instantaneous rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_landed_cost_status" AS ENUM ('DRAFT', 'APPLIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_landed_cost_basis" AS ENUM ('VALUE', 'QUANTITY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_landed_cost_charge_type" AS ENUM ('FREIGHT', 'DUTY', 'INSURANCE', 'HANDLING', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_landed_cost_vouchers" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "grn_id" integer NOT NULL,
  "voucher_number" text NOT NULL,
  "status" "inv_landed_cost_status" DEFAULT 'DRAFT' NOT NULL,
  "allocation_basis" "inv_landed_cost_basis" DEFAULT 'VALUE' NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "charge_total_cents" bigint DEFAULT 0 NOT NULL,
  "capitalised_value" numeric(18, 4) DEFAULT '0' NOT NULL,
  "expensed_value" numeric(18, 4) DEFAULT '0' NOT NULL,
  "notes" text,
  "applied_at" timestamp,
  "applied_by" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_landed_cost_vouchers_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_landed_cost_charges" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "voucher_id" integer NOT NULL,
  "charge_type" "inv_landed_cost_charge_type" NOT NULL,
  "description" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "vendor_id" integer,
  "reference" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_landed_cost_charges_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_landed_cost_allocations" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "voucher_id" integer NOT NULL,
  "valuation_layer_id" integer,
  "product_variant_id" integer NOT NULL,
  "costing_method" text NOT NULL,
  "weight" numeric(18, 4) NOT NULL,
  "allocated_value" numeric(18, 4) NOT NULL,
  "capitalised_value" numeric(18, 4) NOT NULL,
  "expensed_value" numeric(18, 4) NOT NULL,
  "layer_quantity" numeric(18, 4) NOT NULL,
  "remaining_quantity" numeric(18, 4) NOT NULL,
  "unit_cost_before" numeric(18, 4) NOT NULL,
  "unit_cost_after" numeric(18, 4) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_landed_cost_allocations_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

-- Guarded DO block so a re-run is a no-op rather than a duplicate-object error:
-- `ADD CONSTRAINT` has no `IF NOT EXISTS`.
--
-- Every name below is short on purpose. A Postgres identifier is 63 bytes and
-- anything longer is silently TRUNCATED, so the drizzle-style
-- `<table>_<column>_<ftable>_<fcolumn>_fk` name for these tables — 65 to 73
-- characters — is stored under a different name than the one written here. The
-- `conname = fk.name` guard below then never matches, and this file fails on its
-- second run with "constraint already exists" for a constraint it just failed to
-- find. Which is exactly the failure the guard exists to prevent, arriving from
-- the one direction nobody looks at.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_landed_cost_vouchers', 'inv_landed_cost_vouchers_org_id_organizations_id_fk', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      -- A voucher describes one receipt. Delete the receipt and the voucher
      -- describes nothing, so it goes with it.
      ('inv_landed_cost_vouchers', 'inv_landed_cost_vouchers_grn_id_inv_grns_id_fk', '("grn_id") REFERENCES "inv_grns" ("id") ON DELETE CASCADE'),
      ('inv_landed_cost_vouchers', 'inv_landed_cost_vouchers_applied_by_users_id_fk', '("applied_by") REFERENCES "users" ("id")'),
      ('inv_landed_cost_vouchers', 'inv_landed_cost_vouchers_created_by_users_id_fk', '("created_by") REFERENCES "users" ("id")'),
      ('inv_landed_cost_vouchers', 'fk_inv_landed_cost_vouchers_grn_org', '("org_id", "grn_id") REFERENCES "inv_grns" ("org_id", "id")'),

      ('inv_landed_cost_charges', 'inv_landed_cost_charges_org_id_organizations_id_fk', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_landed_cost_charges', 'fk_inv_lc_charges_voucher', '("voucher_id") REFERENCES "inv_landed_cost_vouchers" ("id") ON DELETE CASCADE'),
      ('inv_landed_cost_charges', 'inv_landed_cost_charges_vendor_id_inv_vendors_id_fk', '("vendor_id") REFERENCES "inv_vendors" ("id") ON DELETE SET NULL'),
      ('inv_landed_cost_charges', 'fk_inv_landed_cost_charges_voucher_org', '("org_id", "voucher_id") REFERENCES "inv_landed_cost_vouchers" ("org_id", "id")'),

      ('inv_landed_cost_allocations', 'inv_landed_cost_allocations_org_id_organizations_id_fk', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_landed_cost_allocations', 'fk_inv_lc_allocations_voucher', '("voucher_id") REFERENCES "inv_landed_cost_vouchers" ("id") ON DELETE CASCADE'),
      -- SET NULL rather than CASCADE: an allocation is the evidence of what a
      -- voucher did, and losing that evidence because a layer was later cleaned
      -- up would leave the voucher's totals unexplainable.
      ('inv_landed_cost_allocations', 'fk_inv_lc_allocations_layer', '("valuation_layer_id") REFERENCES "inv_valuation_layers" ("id") ON DELETE SET NULL'),
      ('inv_landed_cost_allocations', 'fk_inv_lc_allocations_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE RESTRICT'),
      ('inv_landed_cost_allocations', 'fk_inv_landed_cost_allocations_voucher_org', '("org_id", "voucher_id") REFERENCES "inv_landed_cost_vouchers" ("org_id", "id")'),
      -- MATCH SIMPLE, so the NULL layer a STANDARD-cost allocation carries passes
      -- the pair rather than needing an exemption.
      ('inv_landed_cost_allocations', 'fk_inv_landed_cost_allocations_layer_org', '("org_id", "valuation_layer_id") REFERENCES "inv_valuation_layers" ("org_id", "id")')
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

-- A charge of zero is not a charge, and a negative one is a credit note — which
-- reduces what was paid for goods, not what it cost to land them, and belongs on
-- the purchase order rather than here. Refusing it in the schema keeps the
-- apportionment's assumption (every weight and every total non-negative) true by
-- construction rather than by the service remembering to check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_landed_cost_charges_amount') THEN
    ALTER TABLE "inv_landed_cost_charges"
      ADD CONSTRAINT "chk_inv_landed_cost_charges_amount" CHECK (
        "amount_cents" > 0 AND char_length(btrim("description")) >= 1
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_landed_cost_charges" VALIDATE CONSTRAINT "chk_inv_landed_cost_charges_amount";
--> statement-breakpoint

-- The identity every allocation row must satisfy. Stated here rather than only in
-- the service, because it is the whole claim the feature makes: nothing the
-- voucher charged is lost between the invoice and the cost layers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_landed_cost_allocations_split') THEN
    ALTER TABLE "inv_landed_cost_allocations"
      ADD CONSTRAINT "chk_inv_landed_cost_allocations_split" CHECK (
        "allocated_value" = "capitalised_value" + "expensed_value"
        AND "capitalised_value" >= 0
        AND "expensed_value" >= 0
        AND "remaining_quantity" <= "layer_quantity"
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_landed_cost_allocations" VALIDATE CONSTRAINT "chk_inv_landed_cost_allocations_split";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_landed_cost_vouchers_org_number"
  ON "inv_landed_cost_vouchers" ("org_id", "voucher_number");
--> statement-breakpoint

-- "What has been charged against this receipt" — the read behind the landed-cost
-- panel on a goods receipt. Leads with `org_id` because RLS adds
-- `org_id = app.current_org_id()` to every read here, and an index that does not
-- supply `org_id` itself can never serve an index-only scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_landed_cost_vouchers_org_grn"
  ON "inv_landed_cost_vouchers" ("org_id", "grn_id");
--> statement-breakpoint

-- "Which vouchers are still waiting to be applied" — the accountant's queue.
CREATE INDEX IF NOT EXISTS "idx_inv_landed_cost_vouchers_org_status"
  ON "inv_landed_cost_vouchers" ("org_id", "status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_landed_cost_charges_org_voucher"
  ON "inv_landed_cost_charges" ("org_id", "voucher_id");
--> statement-breakpoint

-- One allocation per (voucher, layer): applying a voucher twice cannot double a
-- layer's cost even if the idempotency claim above it were somehow lost.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_landed_cost_allocations_voucher_layer"
  ON "inv_landed_cost_allocations" ("org_id", "voucher_id", "valuation_layer_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_landed_cost_allocations_org_voucher"
  ON "inv_landed_cost_allocations" ("org_id", "voucher_id");
--> statement-breakpoint

-- "What has this layer absorbed" — the drill-down from a revalued layer back to
-- the vouchers that moved it.
CREATE INDEX IF NOT EXISTS "idx_inv_landed_cost_allocations_org_layer"
  ON "inv_landed_cost_allocations" ("org_id", "valuation_layer_id");
--> statement-breakpoint

-- A line table takes its tenant from its parent rather than from the caller, so a
-- client cannot attribute a charge to another organisation and the composite
-- foreign keys above always have an org to match on.
DROP TRIGGER IF EXISTS "trg_set_org_id" ON "inv_landed_cost_charges";
--> statement-breakpoint

CREATE TRIGGER "trg_set_org_id"
  BEFORE INSERT ON "inv_landed_cost_charges"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('inv_landed_cost_vouchers', 'id', 'org_id', 'voucher_id');
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_set_org_id" ON "inv_landed_cost_allocations";
--> statement-breakpoint

CREATE TRIGGER "trg_set_org_id"
  BEFORE INSERT ON "inv_landed_cost_allocations"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('inv_landed_cost_vouchers', 'id', 'org_id', 'voucher_id');
--> statement-breakpoint

-- Tenant isolation, the same shape every other inventory table carries. Grants to
-- `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this block is part of the migration that creates it rather than a
-- follow-up.
ALTER TABLE "inv_landed_cost_vouchers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_landed_cost_vouchers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_landed_cost_vouchers"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_landed_cost_charges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_landed_cost_charges";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_landed_cost_charges"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_landed_cost_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_landed_cost_allocations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_landed_cost_allocations"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- The key the new routes are gated on. Adding one to a role template reaches new
-- organisations only — `seedSystemRolesForOrg` grants on role *creation*, and
-- `seed-system-roles.spec.ts` asserts a re-seed must not touch an existing role's
-- grants — so without the backfill below the key would be held by nobody
-- anywhere, and every landed-cost route would 403 for every existing tenant.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES (
  'inventory:landed-cost:manage',
  'inventory:landed-cost',
  'manage',
  'Raise landed-cost vouchers and apply freight, duty and handling into inventory cost layers',
  'inventory',
  true
)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:landed-cost:manage', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:landed-cost:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
