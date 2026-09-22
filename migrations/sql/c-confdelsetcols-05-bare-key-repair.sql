SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_sales_orders"
  DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_channel_id_org";
--> statement-breakpoint

ALTER TABLE "inv_sales_orders"
  ADD CONSTRAINT "fk_inv_sales_orders_channel_id_org"
  FOREIGN KEY ("org_id", "channel_id")
  REFERENCES "inv_channels"("org_id", "id")
  ON DELETE SET NULL ("channel_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "inv_sales_orders"
  VALIDATE CONSTRAINT "fk_inv_sales_orders_channel_id_org";
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments"
  DROP CONSTRAINT IF EXISTS "fk_inv_stock_adjustments_scrap_location_id_org";
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments"
  ADD CONSTRAINT "fk_inv_stock_adjustments_scrap_location_id_org"
  FOREIGN KEY ("org_id", "scrap_location_id")
  REFERENCES "inv_locations"("org_id", "id")
  ON DELETE SET NULL ("scrap_location_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustments"
  VALIDATE CONSTRAINT "fk_inv_stock_adjustments_scrap_location_id_org";
