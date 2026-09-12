-- The checkout used to call the payment provider BEFORE inserting its local row, so any failure
-- between the two left a payable order at the provider that this system had no record of. The
-- payment was still recorded on arrival (the webhook resolves the org from notes), but activation is
-- gated on a purchase row existing, so the customer was charged and given nothing.
--
-- Making provider_order_id nullable lets the row be written FIRST, as a durable statement of intent,
-- and updated with the provider's order id once it exists. The UNIQUE constraint is preserved and
-- keeps working: in PostgreSQL a UNIQUE index permits many NULLs, so unclaimed intent rows do not
-- collide with each other while two real orders still cannot share an id.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "subscription_purchases" ALTER COLUMN "provider_order_id" DROP NOT NULL;
--> statement-breakpoint
-- An intent row that never reached the provider is abandoned, not pending: it holds no order anyone
-- could pay. This index is what a reconciliation sweep reads to find and expire them.
CREATE INDEX IF NOT EXISTS "idx_subscription_purchases_unclaimed_intent"
  ON "subscription_purchases" ("org_id", "created_at")
  WHERE "provider_order_id" IS NULL;
