-- NEO-9 -- kits.
--
-- A kit is a SKU a customer can order that does not exist until somebody builds
-- it: a gift set, a starter pack, a bundle. The only way to sell one before this
-- was to hold it as ordinary stock and let the shelf count drift from the
-- components sitting beside it.
--
-- **A bill of materials for stock, not for manufacturing.** No routing, no
-- operation, no work centre, no labour. Assembling consumes the components and
-- creates the kit, in one command at one moment; a business that needs a shop
-- floor needs a manufacturing module, and pretending this is one would be the
-- worst kind of half-feature.
--
-- The kit's cost is what the components *actually* consumed, read back off the
-- ledger rows the engine wrote, never estimated: estimating is exact under
-- weighted average and wrong under FIFO the moment an issue crosses a layer
-- boundary. Disassembly gives that exact figure back, apportioned by each
-- component's share of the build's cost, so value is conserved to the last paise
-- and no variance nobody asked for is posted.
--
-- The four movement types are their own rather than ADJUSTMENT_IN/OUT: an
-- adjustment means "the count was wrong" and this means "we built something",
-- and a warehouse reading its own movement report should be able to tell those
-- apart.
--
-- A component may appear once per kit. The same component twice is two rows every
-- reader has to add up, so the unique index refuses it and the Zod schema says so
-- in words.
-- `ALTER TYPE ... ADD VALUE` runs inside this migration's transaction, which is
-- legal from Postgres 12 onwards provided the new label is not *used* in the same
-- transaction. Nothing below writes one, so this is safe here; a later migration
-- that both adds a label and inserts it would have to be split.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TYPE "inv_txn_type" ADD VALUE IF NOT EXISTS 'KIT_ASSEMBLE_IN';
--> statement-breakpoint
ALTER TYPE "inv_txn_type" ADD VALUE IF NOT EXISTS 'KIT_ASSEMBLE_OUT';
--> statement-breakpoint
ALTER TYPE "inv_txn_type" ADD VALUE IF NOT EXISTS 'KIT_DISASSEMBLE_IN';
--> statement-breakpoint
ALTER TYPE "inv_txn_type" ADD VALUE IF NOT EXISTS 'KIT_DISASSEMBLE_OUT';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_kit_components" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "kit_variant_id" integer NOT NULL,
  "component_variant_id" integer NOT NULL,
  "quantity_per" numeric(18, 4) NOT NULL,
  "line_order" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_kit_components_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_kit_components_qty_positive" CHECK ("quantity_per" > 0),
  CONSTRAINT "chk_inv_kit_components_not_self" CHECK ("kit_variant_id" <> "component_variant_id")
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_kit_components" ADD CONSTRAINT "inv_kit_components_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_kit_components" ADD CONSTRAINT "inv_kit_components_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_kit_components" ADD CONSTRAINT "fk_inv_kit_components_kit_org"
    FOREIGN KEY ("org_id", "kit_variant_id") REFERENCES "inv_product_variants"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_kit_components" ADD CONSTRAINT "fk_inv_kit_components_component_org"
    FOREIGN KEY ("org_id", "component_variant_id") REFERENCES "inv_product_variants"("org_id", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_kit_components" VALIDATE CONSTRAINT "inv_kit_components_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_kit_components" VALIDATE CONSTRAINT "inv_kit_components_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_kit_components" VALIDATE CONSTRAINT "fk_inv_kit_components_kit_org";
--> statement-breakpoint
ALTER TABLE "inv_kit_components" VALIDATE CONSTRAINT "fk_inv_kit_components_component_org";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_kit_components_kit_component"
  ON "inv_kit_components" ("org_id", "kit_variant_id", "component_variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_kit_components_org_kit"
  ON "inv_kit_components" ("org_id", "kit_variant_id", "line_order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_kit_components_org_component"
  ON "inv_kit_components" ("org_id", "component_variant_id");
--> statement-breakpoint

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:kits:assemble', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'inventory:kits:assemble')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
