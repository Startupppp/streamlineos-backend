-- 0580 — B1. The materials pack: construction and interior goods, dark stores
-- with a delivery zone, and the construction projects that consume them.
--
-- ## Why a pack rather than columns everybody gets
--
-- `inv_settings` already carries four of these (`warehouse`, `kirana`,
-- `pharmacy`, `gst`) and the reason holds again: a grade and a finish are the
-- first two questions a tile buyer asks and complete noise to a pharmacy. The
-- flag hides the fields, the navigation and the validation; it never deletes
-- what was captured, so a pack switched off and on again finds its rows intact.
--
-- ## What is genuinely new, and what is reused
--
-- New: the eight catalogue attributes a materials buyer selects on, a facility
-- type and zone on the warehouse, and two tables for construction projects and
-- the material each one still needs.
--
-- Reused, deliberately not rebuilt: the stock ledger, reservations
-- (`inv_stock_reservations` is already polymorphic on `source_type`, so a
-- project reservation is `source_type = 'PROJECT_REQUIREMENT'` and needs no new
-- table), receipts, picking, transfers, adjustments, purchase orders, the
-- webhook outbox and the audit trail. A second reservation table would be a
-- second answer to "how much is available", which is the one question this
-- system exists to answer once.
--
-- ## Locking, per §3 Migrations
--
-- `inv_products`, `inv_warehouses` and `inv_settings` are live, so every column
-- is added nullable or with a default (Postgres 11+ stores a non-volatile
-- default in the catalogue rather than rewriting the table). The two new tables
-- take their FKs `NOT VALID` then `VALIDATE`, because `ADD CONSTRAINT … FOREIGN
-- KEY` takes ACCESS EXCLUSIVE on BOTH sides and `organizations`/`users` are
-- shared by every tenant. `lock_timeout` makes a contended statement fail fast
-- rather than queue every write behind it.

SET lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- A dark store is a warehouse that never sees a customer: it exists to be picked
-- from inside the delivery promise. The distinction is operational, not
-- cosmetic — a stockout at a dark store fails a 90-minute order, a stockout at
-- the mother warehouse fails a replenishment run days from now, and the two
-- belong in different queues.
CREATE TYPE "public"."inv_facility_type" AS ENUM ('DARK_STORE', 'WAREHOUSE', 'YARD', 'SITE_STORE');
--> statement-breakpoint

-- The material families a construction and interiors catalogue actually splits
-- on. Wider than `inv_categories` (which is the tenant's own tree and can be
-- anything) and narrower than free text: the family is what the reorder and
-- substitution logic keys on, so it has to be a closed set.
CREATE TYPE "public"."inv_material_family" AS ENUM (
  'CEMENT_AGGREGATE', 'STEEL_REBAR', 'BRICK_BLOCK', 'TILE_STONE', 'PAINT_COATING',
  'PLUMBING', 'ELECTRICAL', 'SANITARYWARE', 'WOOD_PANEL', 'GLASS_MIRROR',
  'HARDWARE_FASTENER', 'ADHESIVE_CHEMICAL', 'FALSE_CEILING', 'LIGHTING', 'OTHER'
);
--> statement-breakpoint

-- A project's life, from the site office's point of view. `ON_HOLD` is kept
-- separate from `CANCELLED` because held material stays reserved and cancelled
-- material must be released — the two cannot share a label.
CREATE TYPE "public"."inv_project_status" AS ENUM ('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');
--> statement-breakpoint

-- What a single material requirement on a project is waiting for. `AT_RISK` is
-- derived, never set by hand: it is what the requirement becomes when the
-- required-by date is inside the lead time and nothing is reserved.
CREATE TYPE "public"."inv_requirement_status" AS ENUM ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The pack flag
-- ---------------------------------------------------------------------------

ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_materials" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Dark stores: a warehouse that knows which part of the city it serves
-- ---------------------------------------------------------------------------

ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "facility_type" "inv_facility_type" DEFAULT 'WAREHOUSE' NOT NULL;
--> statement-breakpoint
-- Free text rather than an enum: a zone is a business's own carve-up of a city
-- and the next city has different ones. Hyderabad's four are seeded, not
-- hard-coded into the type system.
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "zone" text;
--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "zone_label" text;
--> statement-breakpoint
-- The promise this facility is expected to keep, in minutes. It is what makes a
-- stockout here urgent: 90 minutes is a customer waiting, not a planning cycle.
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "delivery_promise_minutes" integer;
--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "service_radius_km" numeric(6, 2);
--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "latitude" numeric(9, 6);
--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "longitude" numeric(9, 6);
--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "chk_inv_warehouses_promise_positive"
  CHECK ("delivery_promise_minutes" IS NULL OR "delivery_promise_minutes" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_warehouses" VALIDATE CONSTRAINT "chk_inv_warehouses_promise_positive";
--> statement-breakpoint
-- "Which dark stores serve the north zone" is the query behind every transfer
-- suggestion and every alternative-store prompt on a shortage.
CREATE INDEX IF NOT EXISTS "idx_inv_warehouses_org_zone" ON "inv_warehouses" ("org_id", "zone") WHERE "zone" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_warehouses_org_facility" ON "inv_warehouses" ("org_id", "facility_type");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Catalogue attributes
-- ---------------------------------------------------------------------------

ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "brand" text;
--> statement-breakpoint
-- A grade is the strength or class printed on the bag or the bar — OPC 53,
-- Fe500D, IS 2185. It is not a variant axis: two grades of cement are two
-- products with two reorder points, not two sizes of one product.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "material_grade" text;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "finish" text;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "colour" text;
--> statement-breakpoint
-- The nominal size as the trade writes it — "600x600 mm", "12 mm", "8 ft x 4 ft".
-- Deliberately a label and not three numbers: `inv_product_variants` already
-- holds real millimetres for the packer, and the two answer different questions.
-- A picker matching a printed carton needs the trade's own string.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "dimension_label" text;
--> statement-breakpoint
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "material_family" "inv_material_family";
--> statement-breakpoint
-- How many stock units are in one selling pack — 12 tiles per box, 20 kg per
-- bag. A count, so it multiplies against the ledger quantity without a unit
-- conversion; the unit itself is the product's own `uom_id`.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "pack_size" numeric(18, 4);
--> statement-breakpoint
-- The supplier's own code for this item, which is what appears on their invoice
-- and is therefore what a receiving clerk has in front of them.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "supplier_code" text;
--> statement-breakpoint
-- Days from placing an order to the goods arriving. `inv_reorder_rules` holds a
-- per-warehouse override; this is the catalogue default for a SKU with no rule
-- yet, which is most of them on day one.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "lead_time_days" integer;
--> statement-breakpoint
-- How much to buy when the reorder point is crossed. `reorder_point` has been
-- here since the beginning and answered "when"; nothing answered "how much", so
-- every suggestion had to invent a quantity.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "reorder_quantity" numeric(18, 4);
--> statement-breakpoint

-- A pack of zero is a division by zero waiting in the conversion; a negative
-- lead time is a delivery before the order. Both are constraints rather than
-- service checks because neither is a value anyone can explain afterwards.
ALTER TABLE "inv_products" ADD CONSTRAINT "chk_inv_products_pack_size_positive"
  CHECK ("pack_size" IS NULL OR "pack_size" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_pack_size_positive";
--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "chk_inv_products_lead_time_nonneg"
  CHECK ("lead_time_days" IS NULL OR "lead_time_days" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_lead_time_nonneg";
--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "chk_inv_products_reorder_quantity_positive"
  CHECK ("reorder_quantity" IS NULL OR "reorder_quantity" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_products" VALIDATE CONSTRAINT "chk_inv_products_reorder_quantity_positive";
--> statement-breakpoint

-- Brand and family are the two filters a materials catalogue is browsed by, and
-- both are answered from the tenant's slice. Partial, because outside the
-- materials pack no row carries either.
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_brand" ON "inv_products" ("org_id", "brand") WHERE "brand" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_material_family" ON "inv_products" ("org_id", "material_family") WHERE "material_family" IS NOT NULL;
--> statement-breakpoint
-- Receiving clerks search by the code on the supplier's invoice. Trigram, not
-- `ILIKE '%…%'`, per §3.
CREATE INDEX IF NOT EXISTS "idx_inv_products_supplier_code_trgm" ON "inv_products" USING gin ("supplier_code" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_products_brand_trgm" ON "inv_products" USING gin ("brand" gin_trgm_ops);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Construction projects
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "inv_projects" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  -- The customer this site belongs to, when there is one. Nullable because a
  -- builder's own site has no external client, and `ON DELETE SET NULL` because
  -- losing the client must not take the material history with it.
  "client_id" integer,
  "site_address" text,
  "city" text,
  -- Which delivery zone the site sits in. Matches `inv_warehouses.zone`, so
  -- "which dark store is nearest this site" is a lookup rather than a guess.
  "zone" text,
  "site_contact_name" text,
  "site_contact_phone" text,
  "status" "inv_project_status" DEFAULT 'PLANNING' NOT NULL,
  "starts_on" date,
  "ends_on" date,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  -- Soft delete, per §3: a project is a business entity and its material
  -- history has to survive somebody tidying up the list.
  "deleted_at" timestamp
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_project_requirements" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  -- Which store the site expects to be served from. Nullable: "we need 200 bags
  -- by Friday" is a real requirement before anyone has decided where they come
  -- from, and forcing a store here would make the planner guess.
  "warehouse_id" integer,
  "required_qty" numeric(18, 4) NOT NULL,
  -- What has actually left for site. Never derived on the fly from the ledger:
  -- a requirement is fulfilled by named dispatches and this is the running total
  -- those dispatches write, so a reversed dispatch reduces it too.
  "fulfilled_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
  "required_by" date,
  "status" "inv_requirement_status" DEFAULT 'DRAFT' NOT NULL,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Tenant keys first: every read is `org_id = $1` and the composite unique is
-- what stops one tenant's project code blocking another's (§3).
ALTER TABLE "inv_projects" ADD CONSTRAINT "uniq_inv_projects_org_id" UNIQUE ("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_projects_org_code_live" ON "inv_projects" ("org_id", "code") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_projects_org_status" ON "inv_projects" ("org_id", "status") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_projects_org_zone" ON "inv_projects" ("org_id", "zone") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_projects_client" ON "inv_projects" ("org_id", "client_id") WHERE "client_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_projects_name_trgm" ON "inv_projects" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint

ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "uniq_inv_project_requirements_org_id" UNIQUE ("org_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_project_reqs_org_project" ON "inv_project_requirements" ("org_id", "project_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_project_reqs_org_variant" ON "inv_project_requirements" ("org_id", "product_variant_id");
--> statement-breakpoint
-- The at-risk sweep: open requirements ordered by the date they are needed.
-- Partial, so a finished project's lines never enter the scan.
CREATE INDEX IF NOT EXISTS "idx_inv_project_reqs_org_due"
  ON "inv_project_requirements" ("org_id", "required_by")
  WHERE "status" IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED');
--> statement-breakpoint

ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "chk_inv_project_requirements_qty_positive"
  CHECK ("required_qty" > 0);
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "chk_inv_project_requirements_fulfilled_nonneg"
  CHECK ("fulfilled_qty" >= 0);
--> statement-breakpoint

-- FKs added NOT VALID then validated separately: `organizations` and `users` are
-- shared by every tenant and a validating scan holds ACCESS EXCLUSIVE on both
-- sides.
ALTER TABLE "inv_projects" ADD CONSTRAINT "fk_inv_projects_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_projects" VALIDATE CONSTRAINT "fk_inv_projects_org";
--> statement-breakpoint
ALTER TABLE "inv_projects" ADD CONSTRAINT "fk_inv_projects_created_by"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_projects" VALIDATE CONSTRAINT "fk_inv_projects_created_by";
--> statement-breakpoint
-- Composite tenant FK, per §3: `org_id` leads the reference so a project can
-- never be pointed at another tenant's customer.
ALTER TABLE "inv_projects" ADD CONSTRAINT "fk_inv_projects_org_client"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") ON DELETE set null NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_projects" VALIDATE CONSTRAINT "fk_inv_projects_org_client";
--> statement-breakpoint

ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_org";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_created_by"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_created_by";
--> statement-breakpoint
-- Composite tenant FKs, per §3: the child carries `org_id` and it leads the
-- reference, so a row can never point at another tenant's parent.
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org_project"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "public"."inv_projects"("org_id", "id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_org_project";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org_variant"
  FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "public"."inv_product_variants"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_org_variant";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org_warehouse"
  FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "public"."inv_warehouses"("org_id", "id") ON DELETE set null NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_org_warehouse";
