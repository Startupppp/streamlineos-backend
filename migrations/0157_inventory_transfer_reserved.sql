-- 0157_inventory_transfer_reserved.sql
-- Adds RESERVED to inv_transfer_status enum and postedBy column to inv_stock_adjustments
-- ALTER TYPE ADD VALUE must run outside a transaction

ALTER TYPE "public"."inv_transfer_status" ADD VALUE IF NOT EXISTS 'RESERVED';

ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "posted_by" text REFERENCES users(id);
