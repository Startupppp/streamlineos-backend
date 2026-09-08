-- 0580.down — Remove channel inventory pools.
--
-- Drops the pool table and the channel link 0580 added to sales orders. Every
-- per-channel allocation and every order's channel attribution goes with it.
--
-- @data-loss: inv_channel_pools, inv_sales_orders
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_so_org_channel";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_channel_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "inv_sales_orders_channel_id_inv_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP COLUMN IF EXISTS "channel_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_channel_pools" CASCADE;
