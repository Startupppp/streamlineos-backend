-- 0561.down — Remove HSN codes and GST tax treatment.
--
-- Every HSN code, tax treatment, GST rate and computed tax amount on products
-- and on purchase, sales and GRN lines is dropped. These are figures on filed
-- and filable documents, so this is the most consequential data loss of any
-- inventory rollback in the chain -- reapplying 0561 brings the columns back
-- empty and the tax on historical documents does not come back with them.
--
-- @data-loss: inv_products, inv_po_lines, inv_so_lines, inv_grn_lines, inv_settings
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_org_hsn";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "chk_inv_products_tax_treatment_rate";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP CONSTRAINT IF EXISTS "chk_inv_so_lines_composition_no_outward_tax";
--> statement-breakpoint
ALTER TABLE "inv_products"
  DROP COLUMN IF EXISTS "hsn_code",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "gst_rate";
--> statement-breakpoint
ALTER TABLE "inv_po_lines"
  DROP COLUMN IF EXISTS "hsn_code",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "tax_amount",
  DROP COLUMN IF EXISTS "gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_so_lines"
  DROP COLUMN IF EXISTS "hsn_code",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "tax_amount",
  DROP COLUMN IF EXISTS "gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines"
  DROP COLUMN IF EXISTS "hsn_code",
  DROP COLUMN IF EXISTS "tax_treatment",
  DROP COLUMN IF EXISTS "tax_rate",
  DROP COLUMN IF EXISTS "gst_mode";
--> statement-breakpoint
ALTER TABLE "inv_settings" DROP COLUMN IF EXISTS "gst_mode";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_tax_treatment";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_gst_mode";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;
