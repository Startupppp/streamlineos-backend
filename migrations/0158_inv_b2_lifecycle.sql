-- 0157_inv_b2_lifecycle.sql
-- B2 wave: SO lifecycle status extensions + PO approvedBy column
-- ALTER TYPE must run outside a transaction

ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'PARTIALLY_RESERVED';
ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'RESERVED';
ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'PICKED';
ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'PACKED';
ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'PARTIALLY_SHIPPED';
ALTER TYPE "public"."inv_so_status" ADD VALUE IF NOT EXISTS 'CLOSED';

ALTER TABLE "inv_purchase_orders" ADD COLUMN IF NOT EXISTS "approved_by" text REFERENCES "users"("id");
ALTER TABLE "inv_purchase_orders" ADD COLUMN IF NOT EXISTS "approved_at" timestamptz;
