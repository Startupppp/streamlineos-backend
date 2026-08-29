-- 0573 — D2. Two tables: the shelf-life a customer contracted for, and the
-- record of every time somebody allocated around it.
--
-- ## Why a second near-expiry number
--
-- 0563 gave the organisation `near_expiry_policy` + `near_expiry_window_days`:
-- an *operational* preference — "don't hand out short-dated stock unless you
-- have to". It is one number for the whole tenant, and it changes the ORDER the
-- allocator picks in (`DEPRIORITIZE` sorts the short-dated tier last) or, at
-- `BLOCK`, refuses it pending an override.
--
-- That is not the same question as the one a customer asks. FEFO already
-- prefers the earliest-expiring lot, so "near expiry" as an ordering rule adds
-- nothing a customer would notice — worse, FEFO actively hands each customer the
-- lot closest to its date, which is precisely the one their receiving bay will
-- refuse. A supermarket buying yoghurt writes a minimum remaining shelf life
-- into the supply agreement: 120 days on arrival, or the pallet comes back at
-- our cost. That number is
--
--   * per customer, not per tenant — the same lot is fine for one and rejected
--     by the next;
--   * a constraint on the candidate SET, not on its order — it removes lots,
--     which no amount of sorting can do;
--   * unrelated to the org's window — a lot 60 days out is not "near expiry"
--     under a 30-day window and still breaks a 120-day contract.
--
-- So `inv_customer_shelf_life_rules` holds the threshold, and it is the only
-- place it lives. A row naming a `client_id` is that customer's contracted
-- floor; the single row with `client_id IS NULL` is the house floor applied to
-- every customer without one. No row at all means no floor, which is the honest
-- default: a shelf-life guarantee is a contract, and there is no default
-- contract. Two partial unique indexes rather than one, because Postgres treats
-- NULLs as distinct and a plain unique would let a tenant accumulate five
-- house rules that silently disagree.
--
-- Deliberately not a column on `clients`: that table belongs to CRM, and an
-- inventory allocation rule hanging off it would make every CRM read carry a
-- warehouse concern (backend §1). Deliberately not on `inv_settings` either —
-- one number per tenant is the thing this exists to stop being.
--
-- Per-SKU exceptions ("this line only, 30 days") are E1's pharmacy pack. Core
-- gets the mechanism; the table takes a variant dimension without a rewrite
-- because the resolution already goes most-specific-first.
--
-- ## Why an overrides table rather than only an audit row
--
-- The override already wrote an `inv_audit_events` row. That row is not an
-- answer to "who shipped the short-dated stock, and why" six months later, for
-- three separate reasons:
--
--   1. `InvAuditEventsService.list` deliberately does not project `before`,
--      `after` or `metadata` — D7 drew that redaction line, and the reason is in
--      `after`. The trail was written and unreadable.
--   2. The facts a reviewer needs are not columns anywhere: how short-dated the
--      lot actually was, what the policy in force said at the time, which
--      customer received it. `expiry_date` can be read off `inv_lots` today, but
--      the *policy* is mutable and the answer changes as soon as somebody edits
--      a setting.
--   3. "Who shipped short-dated stock" is a report — across lots, customers and
--      months. That is a query, and a query needs indexed columns.
--
-- So the decision is a first-class row: actor, reason, the verdict it overrode,
-- the lot with its date and days-remaining snapshotted, the policy that was in
-- force, the document and the customer it went to. `inv_audit_events` keeps its
-- row too — it is the immutable event log and this is the domain record; they
-- answer different questions and neither replaces the other.
--
-- Append-only. Editing an override rewrites the reason a customer received
-- stock they may since have rejected, which is the evidence this exists to keep.
--
-- ## Locking (§3 Migrations)
--
-- Both tables are new, so nothing reads them yet — but their foreign keys point
-- at live tables and a bare `ADD CONSTRAINT … FOREIGN KEY` takes ACCESS
-- EXCLUSIVE on BOTH sides for the validating scan. `users`, `organizations` and
-- `clients` are hot; every tenant would queue behind them. Each FK is therefore
-- added `NOT VALID` and validated separately, and `lock_timeout` makes a
-- contended one fail fast instead of blocking the queue behind it. Indexes are
-- the plain form because drizzle's runner wraps a pending migration in one
-- transaction and `CREATE INDEX CONCURRENTLY` cannot appear inside one; the
-- tables are empty at creation, so the plain build is instantaneous.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_customer_shelf_life_rules" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  -- NULL is the house floor: one row per tenant, applied to every customer with
  -- no rule of their own.
  "client_id" integer,
  "min_shelf_life_days" integer NOT NULL,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_cslr_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_allocation_overrides" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,

  -- Attribution is the whole point of the word "audited". NOT NULL: an override
  -- nobody is named on is a bypass with paperwork.
  "actor_user_id" text NOT NULL,
  "reason" text NOT NULL,
  -- What the allocator had said, in its own vocabulary: NEAR_EXPIRY (the org
  -- blocks short-dated stock) or SHELF_LIFE (this customer's contracted floor).
  "verdict" text NOT NULL,

  "product_variant_id" integer NOT NULL,
  -- SET NULL rather than CASCADE, and the two snapshots beside it, so a purged
  -- lot cannot take the evidence with it.
  "lot_id" integer,
  "lot_number" text NOT NULL,
  "lot_expiry_date" date NOT NULL,
  "days_remaining" integer NOT NULL,

  -- The policy as it stood at the moment of the decision. Settings are mutable;
  -- without these the row cannot say what rule was actually overridden.
  "near_expiry_policy" text NOT NULL,
  "near_expiry_window_days" integer NOT NULL,
  "min_shelf_life_days" integer NOT NULL,

  -- Where the stock went: the document, and the customer behind it.
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "client_id" integer,
  "reservation_id" integer,

  "created_at" timestamp DEFAULT now() NOT NULL,

  CONSTRAINT "uniq_inv_allocation_overrides_org_id" UNIQUE ("org_id", "id")
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
      ('inv_customer_shelf_life_rules', 'fk_inv_cslr_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      -- A rule about a customer who no longer exists is not a rule.
      ('inv_customer_shelf_life_rules', 'fk_inv_cslr_client', '("client_id") REFERENCES "clients" ("id") ON DELETE CASCADE'),
      ('inv_customer_shelf_life_rules', 'fk_inv_cslr_client_org', '("org_id", "client_id") REFERENCES "clients" ("org_id", "id")'),
      ('inv_customer_shelf_life_rules', 'fk_inv_cslr_created_by', '("created_by") REFERENCES "users" ("id")'),

      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_actor', '("actor_user_id") REFERENCES "users" ("id")'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_variant_org', '("org_id", "product_variant_id") REFERENCES "inv_product_variants" ("org_id", "id")'),
      -- SET NULL on all three: the override outlives the rows it points at, and
      -- the snapshot columns are what a reviewer actually reads.
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_lot', '("lot_id") REFERENCES "inv_lots" ("id") ON DELETE SET NULL'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_lot_org', '("org_id", "lot_id") REFERENCES "inv_lots" ("org_id", "id")'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_client', '("client_id") REFERENCES "clients" ("id") ON DELETE SET NULL'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_client_org', '("org_id", "client_id") REFERENCES "clients" ("org_id", "id")'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_reservation', '("reservation_id") REFERENCES "inv_stock_reservations" ("id") ON DELETE SET NULL'),
      ('inv_allocation_overrides', 'fk_inv_alloc_ovr_reservation_org', '("org_id", "reservation_id") REFERENCES "inv_stock_reservations" ("org_id", "id")')
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

-- A floor of zero is a rule that does nothing, and a row that does nothing reads
-- as a rule somebody set. "No floor" is expressed by having no row. The upper
-- bound is ten years: a floor longer than any shelf life in the catalogue
-- refuses every lot, which presents as "allocation is broken" rather than as a
-- setting.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_cslr_days') THEN
    ALTER TABLE "inv_customer_shelf_life_rules"
      ADD CONSTRAINT "chk_inv_cslr_days"
      CHECK ("min_shelf_life_days" >= 1 AND "min_shelf_life_days" <= 3650) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_customer_shelf_life_rules" VALIDATE CONSTRAINT "chk_inv_cslr_days";
--> statement-breakpoint

-- An override with no reason is the bypass this table exists to make impossible,
-- and a whitespace reason is no reason, so the length is measured after
-- trimming. The verdict vocabulary is closed: an override may only ever be about
-- a judgement call, and expired / recalled / blocked stock is not one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_alloc_ovr_shape') THEN
    ALTER TABLE "inv_allocation_overrides"
      ADD CONSTRAINT "chk_inv_alloc_ovr_shape" CHECK (
        char_length(btrim("reason")) >= 3
        AND "verdict" IN ('NEAR_EXPIRY', 'SHELF_LIFE')
        AND "days_remaining" >= 0
        AND "near_expiry_window_days" >= 0
        AND "min_shelf_life_days" >= 0
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_allocation_overrides" VALIDATE CONSTRAINT "chk_inv_alloc_ovr_shape";
--> statement-breakpoint

-- One contracted floor per customer. Partial, because NULLs are distinct in a
-- plain unique index and this half must not constrain the house row.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_cslr_org_client"
  ON "inv_customer_shelf_life_rules" ("org_id", "client_id")
  WHERE "client_id" IS NOT NULL;
--> statement-breakpoint

-- Exactly one house floor per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_cslr_org_house"
  ON "inv_customer_shelf_life_rules" ("org_id")
  WHERE "client_id" IS NULL;
--> statement-breakpoint

-- The trail, newest first. Keyset on `(created_at, id)` for the same reason the
-- ledger and the audit log use it: one allocation can write several rows inside
-- one transaction, so `created_at` alone repeats and a cursor on it would skip
-- or duplicate at a page boundary. Leads with `org_id` because RLS adds
-- `org_id = app.current_org_id()` to every read and an index that does not
-- supply `org_id` itself can never serve an index-only scan (§7).
CREATE INDEX IF NOT EXISTS "idx_inv_alloc_ovr_org_created_id"
  ON "inv_allocation_overrides" ("org_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

-- "Where did this lot go, and on whose authority" — the recall question.
CREATE INDEX IF NOT EXISTS "idx_inv_alloc_ovr_org_lot"
  ON "inv_allocation_overrides" ("org_id", "lot_id", "created_at" DESC)
  WHERE "lot_id" IS NOT NULL;
--> statement-breakpoint

-- "What short-dated stock has this customer been sent" — the complaint question.
CREATE INDEX IF NOT EXISTS "idx_inv_alloc_ovr_org_client"
  ON "inv_allocation_overrides" ("org_id", "client_id", "created_at" DESC)
  WHERE "client_id" IS NOT NULL;
--> statement-breakpoint

-- Tenant isolation, the shape every other inventory table carries. Grants to
-- `streamline_app` arrive through `ALTER DEFAULT PRIVILEGES`, so a table left
-- without a policy is readable across every organisation and nothing says so —
-- which is why this is part of the migration that creates them rather than a
-- follow-up.
ALTER TABLE "inv_customer_shelf_life_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_customer_shelf_life_rules";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_customer_shelf_life_rules"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_allocation_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_allocation_overrides";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_allocation_overrides"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
