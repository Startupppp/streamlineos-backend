-- Reverses 0915. Points the five inventory client keys back at the legacy
-- `clients` table and restores inv_project_requirements' bare warehouse key.
--
-- Read this before running it: the rollback restores a known breakage. CRM
-- stopped writing `clients` rows (0913, ticket 08), so with these keys back
-- every shelf-life rule, allocation override, project, vendor or sales order
-- that names a customer created since fails its foreign key. The bare
-- `ON DELETE SET NULL` on (org_id, warehouse_id) also comes back, and deleting
-- a warehouse a requirement names aborts on org_id's NOT NULL again.
--
-- It exists because 0915 destroys no data and the prior state is exactly
-- reproducible. A rollback restores the state before the migration, not a
-- state anyone should want.
--
-- The legacy keys are added NOT VALID and never validated. Rows written since
-- 0915 may name map-minted ids that have no `clients` row, so a validating ADD
-- would fail on existing data and the rollback could not run. NOT VALID checks
-- new writes only, which is the prior behaviour for anything written after it.
-- Every ADD follows a DROP IF EXISTS, so the file can run on a database where
-- 0915 never applied.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "fk_inv_vendors_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "inv_vendors_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_client_id_clients_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "inv_sales_orders_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_client_id_clients_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" DROP CONSTRAINT IF EXISTS "fk_inv_cslr_client_org";
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_client_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" DROP CONSTRAINT IF EXISTS "fk_inv_cslr_client";
--> statement-breakpoint
ALTER TABLE "inv_customer_shelf_life_rules" ADD CONSTRAINT "fk_inv_cslr_client"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" DROP CONSTRAINT IF EXISTS "fk_inv_alloc_ovr_client_org";
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_client_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" DROP CONSTRAINT IF EXISTS "fk_inv_alloc_ovr_client";
--> statement-breakpoint
ALTER TABLE "inv_allocation_overrides" ADD CONSTRAINT "fk_inv_alloc_ovr_client"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_projects" DROP CONSTRAINT IF EXISTS "fk_inv_projects_org_client";
--> statement-breakpoint
ALTER TABLE "inv_projects" ADD CONSTRAINT "fk_inv_projects_org_client"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "public"."clients"("org_id", "id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" DROP CONSTRAINT IF EXISTS "fk_inv_project_reqs_org_warehouse";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ADD CONSTRAINT "fk_inv_project_reqs_org_warehouse"
  FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "public"."inv_warehouses"("org_id", "id") ON DELETE SET NULL NOT VALID;
