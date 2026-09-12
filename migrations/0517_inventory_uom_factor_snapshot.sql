SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-106. inv_product_uom_conversions has existed with zero readers: no service
-- converts an entered quantity to base, and no document records which factor was
-- applied. Without the snapshot, editing a conversion silently rewrites what
-- every historical line meant -- "3 cases" received last year becomes a
-- different number of units the moment somebody corrects the case size.
--
-- The factor is stored per line, not looked up at read time, so a posted
-- document keeps the arithmetic it was posted with.
ALTER TABLE "inv_po_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18, 6);
--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18, 6);
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18, 6);
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18, 6);
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18, 6);
--> statement-breakpoint
-- A zero or negative factor turns a receipt into nothing or into its opposite.
-- The arithmetic itself is not constrained here: the service rounds to four
-- decimal places by an explicit policy, and a CHECK that rounded differently
-- would reject correct rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_po_lines','inv_so_lines','inv_grn_lines','inv_stock_adjustment_lines','inv_stock_transfer_lines']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_' || t || '_uom_factor') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("uom_factor" IS NULL OR "uom_factor" > 0)', t, 'chk_' || t || '_uom_factor');
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- One conversion per product and unit; a second row makes the factor ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_product_uom_conversions_org_product_uom"
  ON "inv_product_uom_conversions" ("org_id", "product_id", "uom_id");
