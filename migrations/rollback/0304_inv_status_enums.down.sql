-- 0304.down — Return adjustment and return statuses to text.
--
-- 0304 converted three text columns to enums. Reversing casts them back to text
-- and drops the two types. The values survive the cast, so this is data-safe in
-- the direction it runs -- but note the asymmetry: going back FORWARD is only
-- possible while every stored string is still a member of the enum, which is
-- exactly the guarantee dropping the type removes.
--
-- The types are dropped last and only if nothing else depends on them; a later
-- migration that reused inv_return_status would make DROP TYPE fail loudly here
-- rather than silently widen its blast radius.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ALTER COLUMN "status" TYPE text USING "status"::text;
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ALTER COLUMN "status" SET DEFAULT 'POSTED';
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ALTER COLUMN "status" TYPE text USING "status"::text;
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ALTER COLUMN "status" TYPE text USING "status"::text;
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
--> statement-breakpoint
DROP TYPE IF EXISTS "inv_adjustment_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "inv_return_status";
