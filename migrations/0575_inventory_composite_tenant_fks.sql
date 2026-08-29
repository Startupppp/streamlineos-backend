-- The composite tenant foreign keys that exist only on the Neon branch.
--
-- backend/CLAUDE.md §3 says every RBAC/tenant edge carries a composite tenant FK,
-- and §3 Migrations says "applied to the Neon branch" is not the same as
-- migrated. Both were true here at once: 79 of the 119 composite same-tenant
-- foreign keys on inv_* tables exist on the shared dev database and in no
-- migration file. They were applied by hand and never authored.
--
-- The consequence is not cosmetic. On a database rebuilt from migrations/ there
-- is nothing stopping a row referencing another organisation's parent -- a
-- stock level pointing at another tenant's location, a PO line at another
-- tenant's variant. It was found by asking why a specific availability
-- divergence could not be constructed: the answer was
-- fk_inv_stock_levels_location_id_org, which turned out not to exist outside
-- this one database.
--
-- Every constraint below is added NOT VALID and validated in a separate
-- statement, per §3: ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on
-- BOTH tables while it installs triggers, so doing it in one step stalls every
-- write to both behind any long read.
--
-- Both halves are guarded, because on the database this was written against
-- all 79 already exist and the file must be a no-op there while being the
-- creating statement anywhere else.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  IF to_regclass('public.inv_channel_stock_publications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_channel_stock_publications_channel_id_org'
                     AND conrelid = to_regclass('public.inv_channel_stock_publications')) THEN
    ALTER TABLE "inv_channel_stock_publications" ADD CONSTRAINT "fk_inv_channel_stock_publications_channel_id_org" FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_channel_stock_publications_channel_id_org'
             AND conrelid = to_regclass('public.inv_channel_stock_publications') AND NOT convalidated) THEN
    ALTER TABLE "inv_channel_stock_publications" VALIDATE CONSTRAINT "fk_inv_channel_stock_publications_channel_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_channel_stock_publications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_channel_stock_publications_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_channel_stock_publications')) THEN
    ALTER TABLE "inv_channel_stock_publications" ADD CONSTRAINT "fk_inv_channel_stock_publications_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_channel_stock_publications_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_channel_stock_publications') AND NOT convalidated) THEN
    ALTER TABLE "inv_channel_stock_publications" VALIDATE CONSTRAINT "fk_inv_channel_stock_publications_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_customer_return_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_return_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_customer_return_lines')) THEN
    ALTER TABLE "inv_customer_return_lines" ADD CONSTRAINT "fk_inv_customer_return_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_return_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_customer_return_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_customer_return_lines" VALIDATE CONSTRAINT "fk_inv_customer_return_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_customer_return_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_return_lines_return_id_org'
                     AND conrelid = to_regclass('public.inv_customer_return_lines')) THEN
    ALTER TABLE "inv_customer_return_lines" ADD CONSTRAINT "fk_inv_customer_return_lines_return_id_org" FOREIGN KEY (org_id, return_id) REFERENCES inv_customer_returns(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_return_lines_return_id_org'
             AND conrelid = to_regclass('public.inv_customer_return_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_customer_return_lines" VALIDATE CONSTRAINT "fk_inv_customer_return_lines_return_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_customer_returns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_returns_client_party_id'
                     AND conrelid = to_regclass('public.inv_customer_returns')) THEN
    ALTER TABLE "inv_customer_returns" ADD CONSTRAINT "fk_inv_customer_returns_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_customer_returns_client_party_id'
             AND conrelid = to_regclass('public.inv_customer_returns') AND NOT convalidated) THEN
    ALTER TABLE "inv_customer_returns" VALIDATE CONSTRAINT "fk_inv_customer_returns_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_cycle_count_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_cycle_count_id_org'
                     AND conrelid = to_regclass('public.inv_cycle_count_lines')) THEN
    ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "fk_inv_cycle_count_lines_cycle_count_id_org" FOREIGN KEY (org_id, cycle_count_id) REFERENCES inv_cycle_counts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_cycle_count_id_org'
             AND conrelid = to_regclass('public.inv_cycle_count_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_cycle_count_lines" VALIDATE CONSTRAINT "fk_inv_cycle_count_lines_cycle_count_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_cycle_count_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_location_id_org'
                     AND conrelid = to_regclass('public.inv_cycle_count_lines')) THEN
    ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "fk_inv_cycle_count_lines_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_location_id_org'
             AND conrelid = to_regclass('public.inv_cycle_count_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_cycle_count_lines" VALIDATE CONSTRAINT "fk_inv_cycle_count_lines_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_cycle_count_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_cycle_count_lines')) THEN
    ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "fk_inv_cycle_count_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_count_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_cycle_count_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_cycle_count_lines" VALIDATE CONSTRAINT "fk_inv_cycle_count_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_cycle_counts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_counts_location_id_org'
                     AND conrelid = to_regclass('public.inv_cycle_counts')) THEN
    ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "fk_inv_cycle_counts_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_counts_location_id_org'
             AND conrelid = to_regclass('public.inv_cycle_counts') AND NOT convalidated) THEN
    ALTER TABLE "inv_cycle_counts" VALIDATE CONSTRAINT "fk_inv_cycle_counts_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_cycle_counts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_counts_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_cycle_counts')) THEN
    ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "fk_inv_cycle_counts_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_cycle_counts_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_cycle_counts') AND NOT convalidated) THEN
    ALTER TABLE "inv_cycle_counts" VALIDATE CONSTRAINT "fk_inv_cycle_counts_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_grn_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grn_lines_grn_id_org'
                     AND conrelid = to_regclass('public.inv_grn_lines')) THEN
    ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "fk_inv_grn_lines_grn_id_org" FOREIGN KEY (org_id, grn_id) REFERENCES inv_grns(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grn_lines_grn_id_org'
             AND conrelid = to_regclass('public.inv_grn_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "fk_inv_grn_lines_grn_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_grn_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grn_lines_po_line_id_org'
                     AND conrelid = to_regclass('public.inv_grn_lines')) THEN
    ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "fk_inv_grn_lines_po_line_id_org" FOREIGN KEY (org_id, po_line_id) REFERENCES inv_po_lines(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grn_lines_po_line_id_org'
             AND conrelid = to_regclass('public.inv_grn_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "fk_inv_grn_lines_po_line_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_grns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grns_location_id_org'
                     AND conrelid = to_regclass('public.inv_grns')) THEN
    ALTER TABLE "inv_grns" ADD CONSTRAINT "fk_inv_grns_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grns_location_id_org'
             AND conrelid = to_regclass('public.inv_grns') AND NOT convalidated) THEN
    ALTER TABLE "inv_grns" VALIDATE CONSTRAINT "fk_inv_grns_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_grns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grns_po_id_org'
                     AND conrelid = to_regclass('public.inv_grns')) THEN
    ALTER TABLE "inv_grns" ADD CONSTRAINT "fk_inv_grns_po_id_org" FOREIGN KEY (org_id, po_id) REFERENCES inv_purchase_orders(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grns_po_id_org'
             AND conrelid = to_regclass('public.inv_grns') AND NOT convalidated) THEN
    ALTER TABLE "inv_grns" VALIDATE CONSTRAINT "fk_inv_grns_po_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_load_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_load_lines_load_id_org'
                     AND conrelid = to_regclass('public.inv_load_lines')) THEN
    ALTER TABLE "inv_load_lines" ADD CONSTRAINT "fk_inv_load_lines_load_id_org" FOREIGN KEY (org_id, load_id) REFERENCES inv_loads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_load_lines_load_id_org'
             AND conrelid = to_regclass('public.inv_load_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_load_lines" VALIDATE CONSTRAINT "fk_inv_load_lines_load_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_load_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_load_lines_shipment_id_org'
                     AND conrelid = to_regclass('public.inv_load_lines')) THEN
    ALTER TABLE "inv_load_lines" ADD CONSTRAINT "fk_inv_load_lines_shipment_id_org" FOREIGN KEY (org_id, shipment_id) REFERENCES inv_shipments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_load_lines_shipment_id_org'
             AND conrelid = to_regclass('public.inv_load_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_load_lines" VALIDATE CONSTRAINT "fk_inv_load_lines_shipment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_loads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_loads_carrier_id_org'
                     AND conrelid = to_regclass('public.inv_loads')) THEN
    ALTER TABLE "inv_loads" ADD CONSTRAINT "fk_inv_loads_carrier_id_org" FOREIGN KEY (org_id, carrier_id) REFERENCES inv_carriers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_loads_carrier_id_org'
             AND conrelid = to_regclass('public.inv_loads') AND NOT convalidated) THEN
    ALTER TABLE "inv_loads" VALIDATE CONSTRAINT "fk_inv_loads_carrier_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_loads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_loads_source_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_loads')) THEN
    ALTER TABLE "inv_loads" ADD CONSTRAINT "fk_inv_loads_source_warehouse_id_org" FOREIGN KEY (org_id, source_warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_loads_source_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_loads') AND NOT convalidated) THEN
    ALTER TABLE "inv_loads" VALIDATE CONSTRAINT "fk_inv_loads_source_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_locations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_locations_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_locations')) THEN
    ALTER TABLE "inv_locations" ADD CONSTRAINT "fk_inv_locations_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_locations_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_locations') AND NOT convalidated) THEN
    ALTER TABLE "inv_locations" VALIDATE CONSTRAINT "fk_inv_locations_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_lots') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_lots_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_lots')) THEN
    ALTER TABLE "inv_lots" ADD CONSTRAINT "fk_inv_lots_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_lots_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_lots') AND NOT convalidated) THEN
    ALTER TABLE "inv_lots" VALIDATE CONSTRAINT "fk_inv_lots_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_package_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_package_lines_package_id_org'
                     AND conrelid = to_regclass('public.inv_package_lines')) THEN
    ALTER TABLE "inv_package_lines" ADD CONSTRAINT "fk_inv_package_lines_package_id_org" FOREIGN KEY (org_id, package_id) REFERENCES inv_packages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_package_lines_package_id_org'
             AND conrelid = to_regclass('public.inv_package_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_package_lines" VALIDATE CONSTRAINT "fk_inv_package_lines_package_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_package_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_package_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_package_lines')) THEN
    ALTER TABLE "inv_package_lines" ADD CONSTRAINT "fk_inv_package_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_package_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_package_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_package_lines" VALIDATE CONSTRAINT "fk_inv_package_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_packages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_packages_shipment_id_org'
                     AND conrelid = to_regclass('public.inv_packages')) THEN
    ALTER TABLE "inv_packages" ADD CONSTRAINT "fk_inv_packages_shipment_id_org" FOREIGN KEY (org_id, shipment_id) REFERENCES inv_shipments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_packages_shipment_id_org'
             AND conrelid = to_regclass('public.inv_packages') AND NOT convalidated) THEN
    ALTER TABLE "inv_packages" VALIDATE CONSTRAINT "fk_inv_packages_shipment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_physical_audit_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_audit_id_org'
                     AND conrelid = to_regclass('public.inv_physical_audit_lines')) THEN
    ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "fk_inv_physical_audit_lines_audit_id_org" FOREIGN KEY (org_id, audit_id) REFERENCES inv_physical_audits(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_audit_id_org'
             AND conrelid = to_regclass('public.inv_physical_audit_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_physical_audit_lines" VALIDATE CONSTRAINT "fk_inv_physical_audit_lines_audit_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_physical_audit_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_location_id_org'
                     AND conrelid = to_regclass('public.inv_physical_audit_lines')) THEN
    ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "fk_inv_physical_audit_lines_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_location_id_org'
             AND conrelid = to_regclass('public.inv_physical_audit_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_physical_audit_lines" VALIDATE CONSTRAINT "fk_inv_physical_audit_lines_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_physical_audit_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_physical_audit_lines')) THEN
    ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "fk_inv_physical_audit_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audit_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_physical_audit_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_physical_audit_lines" VALIDATE CONSTRAINT "fk_inv_physical_audit_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_physical_audits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audits_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_physical_audits')) THEN
    ALTER TABLE "inv_physical_audits" ADD CONSTRAINT "fk_inv_physical_audits_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_physical_audits_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_physical_audits') AND NOT convalidated) THEN
    ALTER TABLE "inv_physical_audits" VALIDATE CONSTRAINT "fk_inv_physical_audits_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_pick_list_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_location_id_org'
                     AND conrelid = to_regclass('public.inv_pick_list_lines')) THEN
    ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "fk_inv_pick_list_lines_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_location_id_org'
             AND conrelid = to_regclass('public.inv_pick_list_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "fk_inv_pick_list_lines_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_pick_list_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_pick_list_id_org'
                     AND conrelid = to_regclass('public.inv_pick_list_lines')) THEN
    ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "fk_inv_pick_list_lines_pick_list_id_org" FOREIGN KEY (org_id, pick_list_id) REFERENCES inv_pick_lists(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_pick_list_id_org'
             AND conrelid = to_regclass('public.inv_pick_list_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "fk_inv_pick_list_lines_pick_list_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_pick_list_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_pick_list_lines')) THEN
    ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "fk_inv_pick_list_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_list_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_pick_list_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "fk_inv_pick_list_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_pick_lists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_lists_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_pick_lists')) THEN
    ALTER TABLE "inv_pick_lists" ADD CONSTRAINT "fk_inv_pick_lists_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_lists_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_pick_lists') AND NOT convalidated) THEN
    ALTER TABLE "inv_pick_lists" VALIDATE CONSTRAINT "fk_inv_pick_lists_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_po_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_po_lines_po_id_org'
                     AND conrelid = to_regclass('public.inv_po_lines')) THEN
    ALTER TABLE "inv_po_lines" ADD CONSTRAINT "fk_inv_po_lines_po_id_org" FOREIGN KEY (org_id, po_id) REFERENCES inv_purchase_orders(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_po_lines_po_id_org'
             AND conrelid = to_regclass('public.inv_po_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_po_lines" VALIDATE CONSTRAINT "fk_inv_po_lines_po_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_po_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_po_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_po_lines')) THEN
    ALTER TABLE "inv_po_lines" ADD CONSTRAINT "fk_inv_po_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_po_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_po_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_po_lines" VALIDATE CONSTRAINT "fk_inv_po_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_product_variants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_product_variants_product_id_org'
                     AND conrelid = to_regclass('public.inv_product_variants')) THEN
    ALTER TABLE "inv_product_variants" ADD CONSTRAINT "fk_inv_product_variants_product_id_org" FOREIGN KEY (org_id, product_id) REFERENCES inv_products(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_product_variants_product_id_org'
             AND conrelid = to_regclass('public.inv_product_variants') AND NOT convalidated) THEN
    ALTER TABLE "inv_product_variants" VALIDATE CONSTRAINT "fk_inv_product_variants_product_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_products_category_id_org'
                     AND conrelid = to_regclass('public.inv_products')) THEN
    ALTER TABLE "inv_products" ADD CONSTRAINT "fk_inv_products_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES inv_categories(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_products_category_id_org'
             AND conrelid = to_regclass('public.inv_products') AND NOT convalidated) THEN
    ALTER TABLE "inv_products" VALIDATE CONSTRAINT "fk_inv_products_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_products_purchase_uom_id_org'
                     AND conrelid = to_regclass('public.inv_products')) THEN
    ALTER TABLE "inv_products" ADD CONSTRAINT "fk_inv_products_purchase_uom_id_org" FOREIGN KEY (org_id, purchase_uom_id) REFERENCES inv_uom(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_products_purchase_uom_id_org'
             AND conrelid = to_regclass('public.inv_products') AND NOT convalidated) THEN
    ALTER TABLE "inv_products" VALIDATE CONSTRAINT "fk_inv_products_purchase_uom_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_purchase_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_purchase_orders_vendor_id_org'
                     AND conrelid = to_regclass('public.inv_purchase_orders')) THEN
    ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "fk_inv_purchase_orders_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES inv_vendors(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_purchase_orders_vendor_id_org'
             AND conrelid = to_regclass('public.inv_purchase_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_purchase_orders" VALIDATE CONSTRAINT "fk_inv_purchase_orders_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_purchase_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_purchase_orders_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_purchase_orders')) THEN
    ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "fk_inv_purchase_orders_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_purchase_orders_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_purchase_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_purchase_orders" VALIDATE CONSTRAINT "fk_inv_purchase_orders_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_quality_holds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_holds_location_id_org'
                     AND conrelid = to_regclass('public.inv_quality_holds')) THEN
    ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "fk_inv_quality_holds_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_holds_location_id_org'
             AND conrelid = to_regclass('public.inv_quality_holds') AND NOT convalidated) THEN
    ALTER TABLE "inv_quality_holds" VALIDATE CONSTRAINT "fk_inv_quality_holds_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_quality_holds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_holds_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_quality_holds')) THEN
    ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "fk_inv_quality_holds_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_holds_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_quality_holds') AND NOT convalidated) THEN
    ALTER TABLE "inv_quality_holds" VALIDATE CONSTRAINT "fk_inv_quality_holds_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_quality_inspection_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_inspection_lines_inspection_id_org'
                     AND conrelid = to_regclass('public.inv_quality_inspection_lines')) THEN
    ALTER TABLE "inv_quality_inspection_lines" ADD CONSTRAINT "fk_inv_quality_inspection_lines_inspection_id_org" FOREIGN KEY (org_id, inspection_id) REFERENCES inv_quality_inspections(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_inspection_lines_inspection_id_org'
             AND conrelid = to_regclass('public.inv_quality_inspection_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_quality_inspection_lines" VALIDATE CONSTRAINT "fk_inv_quality_inspection_lines_inspection_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_quality_inspection_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_inspection_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_quality_inspection_lines')) THEN
    ALTER TABLE "inv_quality_inspection_lines" ADD CONSTRAINT "fk_inv_quality_inspection_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_quality_inspection_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_quality_inspection_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_quality_inspection_lines" VALIDATE CONSTRAINT "fk_inv_quality_inspection_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_recall_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_recall_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_recall_lines')) THEN
    ALTER TABLE "inv_recall_lines" ADD CONSTRAINT "fk_inv_recall_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_recall_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_recall_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_recall_lines" VALIDATE CONSTRAINT "fk_inv_recall_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_recall_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_recall_lines_recall_id_org'
                     AND conrelid = to_regclass('public.inv_recall_lines')) THEN
    ALTER TABLE "inv_recall_lines" ADD CONSTRAINT "fk_inv_recall_lines_recall_id_org" FOREIGN KEY (org_id, recall_id) REFERENCES inv_recall_events(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_recall_lines_recall_id_org'
             AND conrelid = to_regclass('public.inv_recall_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_recall_lines" VALIDATE CONSTRAINT "fk_inv_recall_lines_recall_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_reorder_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_reorder_rules_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_reorder_rules')) THEN
    ALTER TABLE "inv_reorder_rules" ADD CONSTRAINT "fk_inv_reorder_rules_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_reorder_rules_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_reorder_rules') AND NOT convalidated) THEN
    ALTER TABLE "inv_reorder_rules" VALIDATE CONSTRAINT "fk_inv_reorder_rules_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_reorder_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_reorder_rules_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_reorder_rules')) THEN
    ALTER TABLE "inv_reorder_rules" ADD CONSTRAINT "fk_inv_reorder_rules_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_reorder_rules_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_reorder_rules') AND NOT convalidated) THEN
    ALTER TABLE "inv_reorder_rules" VALIDATE CONSTRAINT "fk_inv_reorder_rules_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_sales_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_client_id_org'
                     AND conrelid = to_regclass('public.inv_sales_orders')) THEN
    ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_client_id_org'
             AND conrelid = to_regclass('public.inv_sales_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_sales_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_client_party_id'
                     AND conrelid = to_regclass('public.inv_sales_orders')) THEN
    ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_client_party_id'
             AND conrelid = to_regclass('public.inv_sales_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_sales_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_invoice_id_org'
                     AND conrelid = to_regclass('public.inv_sales_orders')) THEN
    ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_invoice_id_org'
             AND conrelid = to_regclass('public.inv_sales_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_sales_orders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_sales_orders')) THEN
    ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_sales_orders_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_sales_orders') AND NOT convalidated) THEN
    ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_serial_numbers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_serial_numbers_current_location_id_org'
                     AND conrelid = to_regclass('public.inv_serial_numbers')) THEN
    ALTER TABLE "inv_serial_numbers" ADD CONSTRAINT "fk_inv_serial_numbers_current_location_id_org" FOREIGN KEY (org_id, current_location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_serial_numbers_current_location_id_org'
             AND conrelid = to_regclass('public.inv_serial_numbers') AND NOT convalidated) THEN
    ALTER TABLE "inv_serial_numbers" VALIDATE CONSTRAINT "fk_inv_serial_numbers_current_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_serial_numbers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_serial_numbers_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_serial_numbers')) THEN
    ALTER TABLE "inv_serial_numbers" ADD CONSTRAINT "fk_inv_serial_numbers_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_serial_numbers_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_serial_numbers') AND NOT convalidated) THEN
    ALTER TABLE "inv_serial_numbers" VALIDATE CONSTRAINT "fk_inv_serial_numbers_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_shipment_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipment_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_shipment_lines')) THEN
    ALTER TABLE "inv_shipment_lines" ADD CONSTRAINT "fk_inv_shipment_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipment_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_shipment_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_shipment_lines" VALIDATE CONSTRAINT "fk_inv_shipment_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_shipment_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipment_lines_shipment_id_org'
                     AND conrelid = to_regclass('public.inv_shipment_lines')) THEN
    ALTER TABLE "inv_shipment_lines" ADD CONSTRAINT "fk_inv_shipment_lines_shipment_id_org" FOREIGN KEY (org_id, shipment_id) REFERENCES inv_shipments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipment_lines_shipment_id_org'
             AND conrelid = to_regclass('public.inv_shipment_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_shipment_lines" VALIDATE CONSTRAINT "fk_inv_shipment_lines_shipment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_shipments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipments_carrier_id_org'
                     AND conrelid = to_regclass('public.inv_shipments')) THEN
    ALTER TABLE "inv_shipments" ADD CONSTRAINT "fk_inv_shipments_carrier_id_org" FOREIGN KEY (org_id, carrier_id) REFERENCES inv_carriers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipments_carrier_id_org'
             AND conrelid = to_regclass('public.inv_shipments') AND NOT convalidated) THEN
    ALTER TABLE "inv_shipments" VALIDATE CONSTRAINT "fk_inv_shipments_carrier_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_shipments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipments_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_shipments')) THEN
    ALTER TABLE "inv_shipments" ADD CONSTRAINT "fk_inv_shipments_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_shipments_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_shipments') AND NOT convalidated) THEN
    ALTER TABLE "inv_shipments" VALIDATE CONSTRAINT "fk_inv_shipments_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_so_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_so_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_so_lines')) THEN
    ALTER TABLE "inv_so_lines" ADD CONSTRAINT "fk_inv_so_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_so_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_so_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_so_lines" VALIDATE CONSTRAINT "fk_inv_so_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_so_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_so_lines_so_id_org'
                     AND conrelid = to_regclass('public.inv_so_lines')) THEN
    ALTER TABLE "inv_so_lines" ADD CONSTRAINT "fk_inv_so_lines_so_id_org" FOREIGN KEY (org_id, so_id) REFERENCES inv_sales_orders(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_so_lines_so_id_org'
             AND conrelid = to_regclass('public.inv_so_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_so_lines" VALIDATE CONSTRAINT "fk_inv_so_lines_so_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_adjustment_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_adjustment_id_org'
                     AND conrelid = to_regclass('public.inv_stock_adjustment_lines')) THEN
    ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "fk_inv_stock_adjustment_lines_adjustment_id_org" FOREIGN KEY (org_id, adjustment_id) REFERENCES inv_stock_adjustments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_adjustment_id_org'
             AND conrelid = to_regclass('public.inv_stock_adjustment_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_adjustment_lines" VALIDATE CONSTRAINT "fk_inv_stock_adjustment_lines_adjustment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_adjustment_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_location_id_org'
                     AND conrelid = to_regclass('public.inv_stock_adjustment_lines')) THEN
    ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "fk_inv_stock_adjustment_lines_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_location_id_org'
             AND conrelid = to_regclass('public.inv_stock_adjustment_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_adjustment_lines" VALIDATE CONSTRAINT "fk_inv_stock_adjustment_lines_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_adjustment_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_stock_adjustment_lines')) THEN
    ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "fk_inv_stock_adjustment_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_adjustment_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_stock_adjustment_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_adjustment_lines" VALIDATE CONSTRAINT "fk_inv_stock_adjustment_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_levels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_levels_location_id_org'
                     AND conrelid = to_regclass('public.inv_stock_levels')) THEN
    ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "fk_inv_stock_levels_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_levels_location_id_org'
             AND conrelid = to_regclass('public.inv_stock_levels') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_levels" VALIDATE CONSTRAINT "fk_inv_stock_levels_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_levels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_levels_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_stock_levels')) THEN
    ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "fk_inv_stock_levels_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_levels_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_stock_levels') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_levels" VALIDATE CONSTRAINT "fk_inv_stock_levels_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_reservations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_location_id_org'
                     AND conrelid = to_regclass('public.inv_stock_reservations')) THEN
    ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "fk_inv_stock_reservations_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_location_id_org'
             AND conrelid = to_regclass('public.inv_stock_reservations') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_reservations" VALIDATE CONSTRAINT "fk_inv_stock_reservations_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_reservations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_stock_reservations')) THEN
    ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "fk_inv_stock_reservations_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_stock_reservations') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_reservations" VALIDATE CONSTRAINT "fk_inv_stock_reservations_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_reservations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_stock_reservations')) THEN
    ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "fk_inv_stock_reservations_warehouse_id_org" FOREIGN KEY (org_id, warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_reservations_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_stock_reservations') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_reservations" VALIDATE CONSTRAINT "fk_inv_stock_reservations_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transactions_location_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transactions')) THEN
    ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "fk_inv_stock_transactions_location_id_org" FOREIGN KEY (org_id, location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transactions_location_id_org'
             AND conrelid = to_regclass('public.inv_stock_transactions') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transactions" VALIDATE CONSTRAINT "fk_inv_stock_transactions_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transactions_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transactions')) THEN
    ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "fk_inv_stock_transactions_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transactions_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_stock_transactions') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transactions" VALIDATE CONSTRAINT "fk_inv_stock_transactions_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transfer_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfer_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transfer_lines')) THEN
    ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "fk_inv_stock_transfer_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfer_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_stock_transfer_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transfer_lines" VALIDATE CONSTRAINT "fk_inv_stock_transfer_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transfer_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfer_lines_transfer_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transfer_lines')) THEN
    ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "fk_inv_stock_transfer_lines_transfer_id_org" FOREIGN KEY (org_id, transfer_id) REFERENCES inv_stock_transfers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfer_lines_transfer_id_org'
             AND conrelid = to_regclass('public.inv_stock_transfer_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transfer_lines" VALIDATE CONSTRAINT "fk_inv_stock_transfer_lines_transfer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transfers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfers_from_location_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transfers')) THEN
    ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "fk_inv_stock_transfers_from_location_id_org" FOREIGN KEY (org_id, from_location_id) REFERENCES inv_locations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfers_from_location_id_org'
             AND conrelid = to_regclass('public.inv_stock_transfers') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transfers" VALIDATE CONSTRAINT "fk_inv_stock_transfers_from_location_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_stock_transfers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfers_from_warehouse_id_org'
                     AND conrelid = to_regclass('public.inv_stock_transfers')) THEN
    ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "fk_inv_stock_transfers_from_warehouse_id_org" FOREIGN KEY (org_id, from_warehouse_id) REFERENCES inv_warehouses(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_stock_transfers_from_warehouse_id_org'
             AND conrelid = to_regclass('public.inv_stock_transfers') AND NOT convalidated) THEN
    ALTER TABLE "inv_stock_transfers" VALIDATE CONSTRAINT "fk_inv_stock_transfers_from_warehouse_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_valuation_layers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_valuation_layers_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_valuation_layers')) THEN
    ALTER TABLE "inv_valuation_layers" ADD CONSTRAINT "fk_inv_valuation_layers_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_valuation_layers_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_valuation_layers') AND NOT convalidated) THEN
    ALTER TABLE "inv_valuation_layers" VALIDATE CONSTRAINT "fk_inv_valuation_layers_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_valuation_layers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_valuation_layers_stock_transaction_id_org'
                     AND conrelid = to_regclass('public.inv_valuation_layers')) THEN
    ALTER TABLE "inv_valuation_layers" ADD CONSTRAINT "fk_inv_valuation_layers_stock_transaction_id_org" FOREIGN KEY (org_id, stock_transaction_id) REFERENCES inv_stock_transactions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_valuation_layers_stock_transaction_id_org'
             AND conrelid = to_regclass('public.inv_valuation_layers') AND NOT convalidated) THEN
    ALTER TABLE "inv_valuation_layers" VALIDATE CONSTRAINT "fk_inv_valuation_layers_stock_transaction_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_vendor_return_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendor_return_lines_product_variant_id_org'
                     AND conrelid = to_regclass('public.inv_vendor_return_lines')) THEN
    ALTER TABLE "inv_vendor_return_lines" ADD CONSTRAINT "fk_inv_vendor_return_lines_product_variant_id_org" FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendor_return_lines_product_variant_id_org'
             AND conrelid = to_regclass('public.inv_vendor_return_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_vendor_return_lines" VALIDATE CONSTRAINT "fk_inv_vendor_return_lines_product_variant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_vendor_return_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendor_return_lines_return_id_org'
                     AND conrelid = to_regclass('public.inv_vendor_return_lines')) THEN
    ALTER TABLE "inv_vendor_return_lines" ADD CONSTRAINT "fk_inv_vendor_return_lines_return_id_org" FOREIGN KEY (org_id, return_id) REFERENCES inv_vendor_returns(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendor_return_lines_return_id_org'
             AND conrelid = to_regclass('public.inv_vendor_return_lines') AND NOT convalidated) THEN
    ALTER TABLE "inv_vendor_return_lines" VALIDATE CONSTRAINT "fk_inv_vendor_return_lines_return_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_vendors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendors_client_id_org'
                     AND conrelid = to_regclass('public.inv_vendors')) THEN
    ALTER TABLE "inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendors_client_id_org'
             AND conrelid = to_regclass('public.inv_vendors') AND NOT convalidated) THEN
    ALTER TABLE "inv_vendors" VALIDATE CONSTRAINT "fk_inv_vendors_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_vendors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendors_client_party_id'
                     AND conrelid = to_regclass('public.inv_vendors')) THEN
    ALTER TABLE "inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_vendors_client_party_id'
             AND conrelid = to_regclass('public.inv_vendors') AND NOT convalidated) THEN
    ALTER TABLE "inv_vendors" VALIDATE CONSTRAINT "fk_inv_vendors_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.inv_webhook_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_webhook_events_webhook_id_org'
                     AND conrelid = to_regclass('public.inv_webhook_events')) THEN
    ALTER TABLE "inv_webhook_events" ADD CONSTRAINT "fk_inv_webhook_events_webhook_id_org" FOREIGN KEY (org_id, webhook_id) REFERENCES inv_webhooks(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_webhook_events_webhook_id_org'
             AND conrelid = to_regclass('public.inv_webhook_events') AND NOT convalidated) THEN
    ALTER TABLE "inv_webhook_events" VALIDATE CONSTRAINT "fk_inv_webhook_events_webhook_id_org";
  END IF;
END $$;
