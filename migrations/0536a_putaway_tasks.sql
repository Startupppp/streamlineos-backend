-- 0536 — B3. The walk between the receiving dock and the shelf.
--
-- A goods receipt lands every accepted unit on one location. Putaway could
-- already *suggest* where those units ought to go (INV-202) and nothing recorded
-- that anybody had taken them there, so receiving bins accumulated stock the
-- pick face never saw and "is this delivery put away" was answerable only by
-- walking the aisle.
--
-- Two tables arrive here:
--
--   * `inv_putaway_tasks` — the document. Where the goods stand now, which
--     receipt they arrived on, who is walking it, and whether the walk is done.
--     `assigned_to` is held exclusively the way a pick wave's is (0535): the
--     claim is a conditional update that fires only while it is null, so two
--     operators handed the same pallet cannot both carry it.
--   * `inv_putaway_task_lines` — one row per (variant, lot, serial) grain,
--     matching `inv_stock_levels`. A line keyed on the variant alone could not
--     send two lots of one SKU to two bins and could not carry a serial at all.
--     `quantity_moved` is what makes a partial putaway a state rather than a
--     loss, and the CHECK is what stops it exceeding what arrived.
--
-- `disposition` is the quarantine half. It is set from the quality state of the
-- goods rather than chosen: a grain covered by a failed inspection on this
-- receipt, or by an active quality hold at the receiving location, is routed to
-- the warehouse's quarantine location and the operator cannot scan it onto a
-- storage shelf instead.
--
-- Locking notes, per §3 Migrations. Every object here is new, so nothing takes
-- a lock on a table anybody is reading — but the foreign keys still point at
-- live ones (`organizations`, `users`, `inv_grns`, `inv_locations`,
-- `inv_warehouses`, `inv_product_variants`), and a bare `ADD CONSTRAINT ...
-- FOREIGN KEY` takes ACCESS EXCLUSIVE on BOTH sides for the whole validating
-- scan. `users` in particular is global: every tenant's authentication would
-- queue behind it. So each FK is added `NOT VALID` and validated in its own
-- statement, and `lock_timeout` makes a contended one fail fast instead of
-- blocking the table behind it.
--
-- The indexes are the plain form on purpose: drizzle's runner wraps every
-- pending migration in one transaction and `CREATE INDEX CONCURRENTLY` cannot
-- appear inside a transaction block at all — see the header of 0533. Both
-- tables are empty at creation, so the plain build is instantaneous rather than
-- a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_putaway_status') THEN
    CREATE TYPE "inv_putaway_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_putaway_disposition') THEN
    CREATE TYPE "inv_putaway_disposition" AS ENUM ('STORAGE', 'QUARANTINE');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_putaway_tasks" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "task_number" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "grn_id" integer,
  "from_location_id" integer NOT NULL,
  "status" "inv_putaway_status" DEFAULT 'PENDING' NOT NULL,
  "assigned_to" text,
  "claimed_at" timestamp,
  "completed_at" timestamp,
  "cancelled_at" timestamp,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_putaway_tasks_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_putaway_task_lines" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "task_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18, 4) NOT NULL,
  "quantity_moved" numeric(18, 4) DEFAULT '0' NOT NULL,
  "disposition" "inv_putaway_disposition" DEFAULT 'STORAGE' NOT NULL,
  "to_location_id" integer,
  CONSTRAINT "uniq_inv_putaway_task_lines_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

-- Every foreign key below is installed in the two-statement form the migration
-- rules require. Written as guarded DO blocks so a re-run is a no-op rather than
-- a duplicate-object error: `ADD CONSTRAINT` has no `IF NOT EXISTS`.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_warehouse', '("warehouse_id") REFERENCES "inv_warehouses" ("id") ON DELETE RESTRICT'),
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_grn', '("grn_id") REFERENCES "inv_grns" ("id") ON DELETE SET NULL'),
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_from_location', '("from_location_id") REFERENCES "inv_locations" ("id") ON DELETE RESTRICT'),
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_assigned_to', '("assigned_to") REFERENCES "users" ("id") ON DELETE SET NULL'),
      ('inv_putaway_tasks', 'fk_inv_putaway_tasks_created_by', '("created_by") REFERENCES "users" ("id")'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_task', '("task_id") REFERENCES "inv_putaway_tasks" ("id") ON DELETE CASCADE'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id")'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_lot', '("lot_id") REFERENCES "inv_lots" ("id") ON DELETE SET NULL'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_serial', '("serial_id") REFERENCES "inv_serial_numbers" ("id") ON DELETE SET NULL'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_to_location', '("to_location_id") REFERENCES "inv_locations" ("id") ON DELETE SET NULL'),
      -- The composite tenant keys. Every inventory line table has one: it is
      -- what makes a cross-tenant parent impossible relationally rather than
      -- only by predicate.
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_task_id_org', '("org_id", "task_id") REFERENCES "inv_putaway_tasks" ("org_id", "id") ON DELETE CASCADE'),
      ('inv_putaway_task_lines', 'fk_inv_putaway_task_lines_product_variant_id_org', '("org_id", "product_variant_id") REFERENCES "inv_product_variants" ("org_id", "id")')
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

-- The pair moves together or the claim is unreadable, exactly as on
-- `inv_pick_lists` (0535): an `assigned_to` with no `claimed_at` cannot say when
-- the walk started, and a `claimed_at` with no assignee names a walk nobody is
-- doing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_putaway_tasks_claim_pair'
  ) THEN
    ALTER TABLE "inv_putaway_tasks"
      ADD CONSTRAINT "chk_inv_putaway_tasks_claim_pair" CHECK (
        ("assigned_to" IS NULL AND "claimed_at" IS NULL)
        OR ("assigned_to" IS NOT NULL AND "claimed_at" IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_putaway_tasks" VALIDATE CONSTRAINT "chk_inv_putaway_tasks_claim_pair";
--> statement-breakpoint

-- A line that asks for nothing is not a task, and a line that has moved more
-- than arrived is stock from nowhere. Both are cheap to make impossible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_putaway_task_lines_quantity'
  ) THEN
    ALTER TABLE "inv_putaway_task_lines"
      ADD CONSTRAINT "chk_inv_putaway_task_lines_quantity" CHECK ("quantity" > 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_putaway_task_lines" VALIDATE CONSTRAINT "chk_inv_putaway_task_lines_quantity";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_putaway_task_lines_moved'
  ) THEN
    ALTER TABLE "inv_putaway_task_lines"
      ADD CONSTRAINT "chk_inv_putaway_task_lines_moved"
      CHECK ("quantity_moved" >= 0 AND "quantity_moved" <= "quantity") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_putaway_task_lines" VALIDATE CONSTRAINT "chk_inv_putaway_task_lines_moved";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_putaway_tasks_org_number"
  ON "inv_putaway_tasks" ("org_id", "task_number");
--> statement-breakpoint

-- One live putaway per receipt. Raising a second task for a delivery somebody is
-- already walking is how the same pallet gets carried twice; a cancelled task is
-- excluded so a mistake can be undone and redone.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_putaway_tasks_org_live_grn"
  ON "inv_putaway_tasks" ("org_id", "grn_id")
  WHERE "grn_id" IS NOT NULL AND "status" <> 'CANCELLED';
--> statement-breakpoint

-- The two queries the workbench makes — "tasks waiting" and "tasks this person
-- is walking" — both lead with the tenant, because RLS adds
-- `org_id = app.current_org_id()` to every read here.
CREATE INDEX IF NOT EXISTS "idx_inv_putaway_tasks_org_status"
  ON "inv_putaway_tasks" ("org_id", "status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_putaway_tasks_org_assignee"
  ON "inv_putaway_tasks" ("org_id", "assigned_to", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_putaway_tasks_org_grn"
  ON "inv_putaway_tasks" ("org_id", "grn_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_putaway_task_lines_task"
  ON "inv_putaway_task_lines" ("task_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_putaway_task_lines_variant"
  ON "inv_putaway_task_lines" ("org_id", "product_variant_id");
--> statement-breakpoint

-- Grants reach new tables through ALTER DEFAULT PRIVILEGES, so a tenant table
-- without a policy is readable org-wide and silently so — 0514 is the whole
-- story of that. Enabled and policied in the same migration that creates them.
ALTER TABLE "inv_putaway_tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_putaway_tasks";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_putaway_tasks"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_putaway_task_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_putaway_task_lines";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_putaway_task_lines"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- Every inventory line table takes its tenant from its parent rather than from
-- the caller, so a client cannot attribute a line to another organisation and
-- the composite foreign key above always has an org to match on.
DROP TRIGGER IF EXISTS "trg_set_org_id" ON "inv_putaway_task_lines";
--> statement-breakpoint

CREATE TRIGGER "trg_set_org_id"
  BEFORE INSERT ON "inv_putaway_task_lines"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('inv_putaway_tasks', 'id', 'org_id', 'task_id');
