-- 0581.down — Remove quick-commerce ASN, platform POs and payout reconciliation.
--
-- The largest inventory rollback in the chain: five tables, three types and six
-- columns across channels, GRNs, sales orders and settings. Order matters --
-- lines before headers, and the GRN/SO links before the tables they point at --
-- so the drops read bottom-up relative to the forward migration.
--
-- Platform payout lines are reconciliation evidence against Blinkit/Zepto
-- settlements. Dropping them removes the record of what was matched and what was
-- disputed, and reapplying 0581 does not bring it back.
--
-- @data-loss: inv_asns, inv_asn_lines, inv_platform_purchase_orders, inv_platform_po_lines, inv_platform_payout_lines, inv_grns, inv_sales_orders, inv_channels, inv_settings
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_grn_org_asn";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP CONSTRAINT IF EXISTS "inv_grns_asn_id_inv_asns_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP COLUMN IF EXISTS "asn_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_so_org_platform_po";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "inv_sales_orders_platform_po_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP COLUMN IF EXISTS "platform_po_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_channels_org_qc_provider";
--> statement-breakpoint
ALTER TABLE "inv_channels" DROP COLUMN IF EXISTS "qc_provider";
--> statement-breakpoint
ALTER TABLE "inv_settings"
  DROP COLUMN IF EXISTS "asn_required_for_grn",
  DROP COLUMN IF EXISTS "pack_quick_commerce",
  DROP COLUMN IF EXISTS "qc_zepto_email_po_enabled";
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_platform_payout_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_platform_po_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_platform_purchase_orders" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_asn_lines" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_asns" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_asn_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_platform_po_status";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_qc_provider";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
