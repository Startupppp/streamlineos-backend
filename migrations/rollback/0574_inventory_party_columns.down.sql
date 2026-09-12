-- 0574.down (party columns) — Drop the party links.
--
-- Three nullable text columns pointing at the party model. Dropping them loses
-- every link that was recorded; the underlying parties survive, the association
-- does not, and re-applying 0574 brings the columns back empty.
--
-- @data-loss: inv_sales_orders, inv_customer_returns, inv_vendors
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP COLUMN IF EXISTS "client_party_id";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP COLUMN IF EXISTS "client_party_id";
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP COLUMN IF EXISTS "client_party_id";
