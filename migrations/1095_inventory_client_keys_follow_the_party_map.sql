-- 0915 — inventory's customer keys point at the party map, not at `clients`
-- =============================================================================
-- Five inventory tables carry a legacy customer id, `client_id`: inv_vendors,
-- inv_sales_orders, inv_customer_shelf_life_rules, inv_allocation_overrides and
-- inv_projects. Between them they had nine foreign keys to the legacy `clients`
-- table: a composite tenant key (org_id, client_id) → clients(org_id, id) on
-- each, plus a bare client_id → clients(id) on four.
--
-- The CRM Party migration stopped writing `clients` (see 0913): a customer
-- created today gets its legacy id from `client_party_map`, and no `clients` row
-- is ever inserted for it. Every one of those nine keys therefore refuses the id
-- of any customer created since. A shelf-life rule, an allocation override or a
-- project for a new customer fails with a foreign-key violation, and
-- `ShelfLifeRulesService` already resolves the id through the map. The check the
-- service passes is not the one the database enforces.
--
-- The map is where legacy client ids live now. `pk_client_party_map` is
-- (organization_id, client_id), so each composite key moves there unchanged in
-- shape: still tenant-scoped, now satisfiable. The bare single-column keys are
-- dropped. They were never tenant-safe, and the composite key replaces them.
--
-- ON DELETE is NO ACTION throughout. A map row goes only when its party is
-- hard-deleted (DPDP erasure cascades business_parties → client_party_map), and
-- 0662 settled that path: the erasure flow clears children explicitly, and a
-- database-level action must not perform a disposition nobody declared.
-- inv_projects' old `ON DELETE SET NULL` never worked anyway. On
-- (org_id, client_id) the bare form nulls org_id as well, which is NOT NULL, so
-- the parent delete aborted (check:composite-fk-set-null).
--
-- inv_project_requirements' warehouse key had the same defect from 0820. A
-- requirement whose warehouse is deleted should lose its warehouse, not its
-- tenant, so it takes Postgres 15's column-list form, `SET NULL (warehouse_id)`.
-- 0662 gave the kb_* structural keys the same shape.
--
-- Each ADD follows a DROP IF EXISTS, so a re-run is a no-op. Each is added
-- NOT VALID and then validated, so the existing-row scan does not hold the
-- stronger lock.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "inv_vendors_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "inv_sales_orders_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" DROP CONSTRAINT IF EXISTS "fk_inv_cslr_client";
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" DROP CONSTRAINT IF EXISTS "fk_inv_alloc_ovr_client";
--> statement-breakpoint

ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "fk_inv_vendors_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_vendors" VALIDATE CONSTRAINT "fk_inv_vendors_client_id_org";
--> statement-breakpoint

ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_client_id_org";
--> statement-breakpoint

ALTER TABLE "inv_customer_shelf_life_rules" DROP CONSTRAINT IF EXISTS "fk_inv_cslr_client_org";
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_client_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" VALIDATE CONSTRAINT "fk_inv_cslr_client_org";
--> statement-breakpoint

ALTER TABLE "inv_allocation_overrides" DROP CONSTRAINT IF EXISTS "fk_inv_alloc_ovr_client_org";
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_client_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" VALIDATE CONSTRAINT "fk_inv_alloc_ovr_client_org";
--> statement-breakpoint

ALTER TABLE "inv_projects" DROP CONSTRAINT IF EXISTS "fk_inv_projects_org_client";
--> statement-breakpoint
ALTER TABLE "inv_projects" ADD CONSTRAINT "fk_inv_projects_org_client"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."client_party_map"("organization_id", "client_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_projects" VALIDATE CONSTRAINT "fk_inv_projects_org_client";
--> statement-breakpoint

ALTER TABLE "inv_project_requirements" DROP CONSTRAINT IF EXISTS "fk_inv_project_reqs_org_warehouse";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org_warehouse"
  FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "public"."inv_warehouses"("org_id", "id") ON DELETE SET NULL ("warehouse_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" VALIDATE CONSTRAINT "fk_inv_project_reqs_org_warehouse";
