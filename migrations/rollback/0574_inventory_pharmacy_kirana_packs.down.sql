-- 0574.down (pharmacy/kirana packs) — Remove the pharmacy and kirana fields.
--
-- Drug schedule, high-alert and LASA grouping are dispensing-safety attributes.
-- Removing them does not just lose data: it removes the fields the application
-- uses to warn on look-alike/sound-alike and Schedule H1 products.
--
-- @data-loss: inv_products, inv_lots, inv_grn_lines, inv_settings
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_org_drug_schedule";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_org_lasa_group";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "chk_inv_products_mrp_paise_positive";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "chk_inv_products_qty_input_precision";
--> statement-breakpoint
ALTER TABLE "inv_lots" DROP CONSTRAINT IF EXISTS "chk_inv_lots_mrp_paise_positive";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "chk_inv_grn_lines_mrp_paise_positive";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "chk_inv_grn_lines_purchase_rate_paise_positive";
--> statement-breakpoint
ALTER TABLE "inv_products"
  DROP COLUMN IF EXISTS "drug_schedule",
  DROP COLUMN IF EXISTS "is_high_alert",
  DROP COLUMN IF EXISTS "lasa_group",
  DROP COLUMN IF EXISTS "mrp_paise",
  DROP COLUMN IF EXISTS "mrp_required",
  DROP COLUMN IF EXISTS "quantity_input_mode",
  DROP COLUMN IF EXISTS "quantity_precision",
  DROP COLUMN IF EXISTS "sale_mode";
--> statement-breakpoint
ALTER TABLE "inv_lots" DROP COLUMN IF EXISTS "mrp_paise";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines"
  DROP COLUMN IF EXISTS "mrp_paise",
  DROP COLUMN IF EXISTS "purchase_rate_paise";
--> statement-breakpoint
ALTER TABLE "inv_settings" DROP COLUMN IF EXISTS "pharmacy_h1_register_enabled";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_drug_schedule";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_qty_input_mode";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_sale_mode";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
