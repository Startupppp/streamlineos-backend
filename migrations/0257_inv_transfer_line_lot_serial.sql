ALTER TABLE "inv_stock_transfer_lines" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "inv_stock_transfer_lines" ADD COLUMN IF NOT EXISTS "serial_id" integer;
