-- 0544 — D3. Inspection plans, and the receipt hold that makes them mean something.
--
-- Two tables and five columns arrive here.
--
--   * `inv_inspection_plans` — which arrivals have to be looked at. Scope is an
--     exclusive arc (backend §3), not an `entity_type`/`entity_id` pair: at most
--     one of variant, product and category, and all three null is the
--     organisation-wide plan. Specificity is *derived* from which one is set, so
--     there is no precedence column that can disagree with the foreign keys.
--   * `inv_inspection_plan_versions` — the rule the plan carried at a point in
--     time. An inspection line records the version that governed it, so the
--     standard a completed result was judged against stays readable after
--     somebody tightens the sampling. That is only true if a published version is
--     never edited, so the service has no update path for one and
--     `uniq_inv_inspection_plan_versions_active` makes "one live rule per plan"
--     hold when two publishes race, where a read-then-write check always loses.
--
-- On `inv_quality_inspection_lines`:
--
--   * `location_id` — where the units stand. The release used to look a level up
--     by `(variant, lot, serial)` and drop the location, so one SKU in two bins
--     collapsed to whichever row came back first and the `QUARANTINE_OUT` landed
--     in the wrong aisle.
--   * `held_quantity` — what this inspection is itself holding in
--     `quality_hold_qty`. The exact figure `pass`, `dispose` and `cancel` release,
--     rather than "the level shows some hold, release the line quantity" — which
--     released against holds another document owned and left those unreleasable.
--     CHECKed as a subset of the line quantity for the same reason the engine
--     checks the buckets against `on_hand`.
--   * `sample_quantity` — how many units the plan requires be physically opened.
--     Never the held quantity: the whole delivery is quarantined whatever the
--     sample says, because a sample that fails condemns the batch it came from.
--   * `plan_version_id` — the rule this line was judged against.
--
-- On `inv_quality_inspections`, `corrects_inspection_id` + `correction_reason`:
-- a completed result is evidence and is never edited, so a mistake is compensated
-- by a new inspection naming the one it supersedes. The partial unique index is
-- what makes "one correction per mistake" true under a race; the CHECK stops a
-- correction with no stated reason.
--
-- Locking notes, per §3 Migrations. The two tables are new, so nothing here takes
-- a lock on a table anybody is reading — but the foreign keys point at live ones
-- (`organizations`, `users`, `inv_product_variants`, `inv_products`,
-- `inv_categories`, `inv_locations`), and a bare `ADD CONSTRAINT … FOREIGN KEY`
-- takes ACCESS EXCLUSIVE on BOTH sides for the validating scan; `users` is
-- global, so every tenant's authentication would queue behind it. Each FK is
-- therefore added `NOT VALID` and validated separately, and `lock_timeout` makes
-- a contended one fail fast rather than block the table behind it. The added
-- columns are nullable or defaulted, which is a catalogue-only rewrite on
-- Postgres 11+, and the indexes are the plain form because drizzle wraps every
-- pending migration in one transaction and `CREATE INDEX CONCURRENTLY` cannot
-- appear inside a transaction block at all.
--
-- The permission key at the end follows `0532`: the catalogue row has to exist
-- before any grant can reference it (`role_permission_grants.permission_key` is a
-- foreign key onto `permissions.name`, and the catalogue sync only writes it at
-- application boot), and role templates grant on role *creation* only, so a new
-- key reaches no existing organisation without a backfill. The slug is the thing
-- to get right: `seedSystemRolesForOrg` mints `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`,
-- so `INVENTORY_MANAGER` and `INVENTORY_QUALITY` — `ROLE_TEMPLATES` slugs an
-- administrator may materialise — name zero rows in a live database. MODULE_MEMBER
-- is deliberately excluded: `buildModuleMemberPermissionKeys` hands members keys
-- ending in `:view` or `:read`, and this is a `:manage`.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_inspection_sampling_method') THEN
    CREATE TYPE "inv_inspection_sampling_method" AS ENUM ('ALL', 'PERCENTAGE', 'FIXED_QUANTITY');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_inspection_plan_version_status') THEN
    CREATE TYPE "inv_inspection_plan_version_status" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_inspection_plans" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "product_variant_id" integer,
  "product_id" integer,
  "category_id" integer,
  "applies_on_receipt" boolean DEFAULT true NOT NULL,
  "applies_on_return" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_inv_inspection_plans_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_inspection_plan_versions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "plan_id" integer NOT NULL,
  "version" integer NOT NULL,
  "sampling_method" "inv_inspection_sampling_method" DEFAULT 'ALL' NOT NULL,
  "sample_value" numeric(18, 4),
  "instructions" text,
  "status" "inv_inspection_plan_version_status" DEFAULT 'DRAFT' NOT NULL,
  "activated_at" timestamp,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_inspection_plan_versions_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

ALTER TABLE "inv_quality_inspection_lines"
  ADD COLUMN IF NOT EXISTS "location_id" integer,
  ADD COLUMN IF NOT EXISTS "held_quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "sample_quantity" numeric(18, 4),
  ADD COLUMN IF NOT EXISTS "plan_version_id" integer;
--> statement-breakpoint

ALTER TABLE "inv_quality_inspections"
  ADD COLUMN IF NOT EXISTS "corrects_inspection_id" integer,
  ADD COLUMN IF NOT EXISTS "correction_reason" text;
--> statement-breakpoint

-- Every foreign key in the two-statement form the migration rules require,
-- written as a guarded DO block so a re-run is a no-op rather than a
-- duplicate-object error: `ADD CONSTRAINT` has no `IF NOT EXISTS`.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('inv_inspection_plans', 'fk_inv_inspection_plans_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plans', 'fk_inv_inspection_plans_variant', '("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plans', 'fk_inv_inspection_plans_product', '("product_id") REFERENCES "inv_products" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plans', 'fk_inv_inspection_plans_category', '("category_id") REFERENCES "inv_categories" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plans', 'fk_inv_inspection_plans_created_by', '("created_by") REFERENCES "users" ("id")'),
      ('inv_inspection_plan_versions', 'fk_inv_inspection_plan_versions_org', '("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plan_versions', 'fk_inv_inspection_plan_versions_plan', '("plan_id") REFERENCES "inv_inspection_plans" ("id") ON DELETE CASCADE'),
      ('inv_inspection_plan_versions', 'fk_inv_inspection_plan_versions_created_by', '("created_by") REFERENCES "users" ("id")'),
      -- The composite tenant key. Every inventory line table has one: it is what
      -- makes a cross-tenant parent impossible relationally rather than only by
      -- predicate.
      ('inv_inspection_plan_versions', 'fk_inv_inspection_plan_versions_plan_id_org', '("org_id", "plan_id") REFERENCES "inv_inspection_plans" ("org_id", "id") ON DELETE CASCADE'),
      ('inv_quality_inspection_lines', 'fk_inv_quality_inspection_lines_location', '("location_id") REFERENCES "inv_locations" ("id")'),
      ('inv_quality_inspection_lines', 'fk_inv_quality_inspection_lines_plan_version', '("plan_version_id") REFERENCES "inv_inspection_plan_versions" ("id") ON DELETE SET NULL'),
      ('inv_quality_inspections', 'fk_inv_quality_inspections_corrects', '("corrects_inspection_id") REFERENCES "inv_quality_inspections" ("id") ON DELETE SET NULL')
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

DO $$
DECLARE
  ck RECORD;
BEGIN
  FOR ck IN
    SELECT * FROM (VALUES
      ('inv_inspection_plans', 'chk_inv_inspection_plans_scope',
       'num_nonnulls(product_variant_id, product_id, category_id) <= 1'),
      ('inv_inspection_plans', 'chk_inv_inspection_plans_trigger',
       'applies_on_receipt OR applies_on_return'),
      ('inv_inspection_plan_versions', 'chk_inv_inspection_plan_versions_version',
       'version > 0'),
      -- `sample_value` means a different thing under each method and nothing at
      -- all under ALL, so the three cases are one constraint rather than three
      -- columns that can disagree.
      ('inv_inspection_plan_versions', 'chk_inv_inspection_plan_versions_sample',
       '(sampling_method = ''ALL'' AND sample_value IS NULL) OR (sampling_method = ''PERCENTAGE'' AND sample_value > 0 AND sample_value <= 100) OR (sampling_method = ''FIXED_QUANTITY'' AND sample_value > 0)'),
      ('inv_quality_inspection_lines', 'chk_inv_quality_inspection_lines_held',
       'held_quantity >= 0 AND held_quantity <= quantity'),
      ('inv_quality_inspections', 'chk_inv_quality_inspections_correction_reason',
       'corrects_inspection_id IS NULL OR correction_reason IS NOT NULL')
    ) AS t(tbl, name, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = ck.name AND conrelid = ck.tbl::regclass
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', ck.tbl, ck.name, ck.expr);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = ck.name AND conrelid = ck.tbl::regclass AND NOT convalidated
    ) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', ck.tbl, ck.name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Partial on `deleted_at IS NULL`: a soft-deleted plan must not hold its code
-- hostage, and the scope is the tenant — a bare unique index lets one
-- organisation's code block every other one (backend §3).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_inspection_plans_org_code_live"
  ON "inv_inspection_plans" ("org_id", "code")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_inspection_plans_org_live"
  ON "inv_inspection_plans" ("org_id", "is_active")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- The three scope probes the resolver makes, each leading with the tenant
-- because RLS adds `org_id = app.current_org_id()` to every read here.
CREATE INDEX IF NOT EXISTS "idx_inv_inspection_plans_variant"
  ON "inv_inspection_plans" ("org_id", "product_variant_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_inspection_plans_product"
  ON "inv_inspection_plans" ("org_id", "product_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_inspection_plans_category"
  ON "inv_inspection_plans" ("org_id", "category_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_inspection_plan_versions_number"
  ON "inv_inspection_plan_versions" ("org_id", "plan_id", "version");
--> statement-breakpoint

-- One live rule per plan. Two ACTIVE versions is a plan that answers a receipt
-- differently depending on which row the query happened to read first.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_inspection_plan_versions_active"
  ON "inv_inspection_plan_versions" ("org_id", "plan_id")
  WHERE "status" = 'ACTIVE';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_inspection_plan_versions_plan"
  ON "inv_inspection_plan_versions" ("plan_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_qi_corrects"
  ON "inv_quality_inspections" ("org_id", "corrects_inspection_id")
  WHERE "corrects_inspection_id" IS NOT NULL;
--> statement-breakpoint

-- Grants reach new tables through ALTER DEFAULT PRIVILEGES, so a tenant table
-- without a policy is readable org-wide and silently so. Enabled and policied in
-- the same migration that creates them.
ALTER TABLE "inv_inspection_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_inspection_plans";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_inspection_plans"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "inv_inspection_plan_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_inspection_plan_versions";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_inspection_plan_versions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- A line table takes its tenant from its parent rather than from the caller, so
-- a client cannot attribute a version to another organisation and the composite
-- foreign key above always has an org to match on.
DROP TRIGGER IF EXISTS "trg_set_org_id" ON "inv_inspection_plan_versions";
--> statement-breakpoint

CREATE TRIGGER "trg_set_org_id"
  BEFORE INSERT ON "inv_inspection_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('inv_inspection_plans', 'id', 'org_id', 'plan_id');
--> statement-breakpoint

INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key", "is_delegable")
VALUES (
  'inventory:quality:plans:manage',
  'inventory:quality:plans',
  'manage',
  'Author and version the inspection plans that decide which arrivals must be inspected before they become available',
  'inventory',
  true
)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
VALUES ('inventory:quality:plans:manage', 'all')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:quality:plans:manage', 'all'
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
