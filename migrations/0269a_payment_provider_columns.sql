-- Custom SQL migration file, put your code below! --

-- Payment references, generalised away from one provider's name.
--
-- Phase 3 ticket 02, the expand half. `subscriptions` carries
-- razorpay_subscription_id, razorpay_customer_id and razorpay_plan_id;
-- subscription_payments and platform_payments carry razorpay_payment_id,
-- razorpay_order_id and razorpay_signature. A second provider cannot store
-- anything without either more provider-named columns -- which is the same
-- mistake twice -- or this.
--
-- Expand only. Every existing column stays and every existing reader keeps
-- working; the new columns are populated alongside them, and a later migration
-- drops the old ones once no reader remains. Doing it as one change would break
-- every reader at once for a benefit nobody could ship incrementally.
--
-- Backfilled with 'razorpay' because that is what every existing row is. A
-- nullable provider would leave the question "which provider was this?"
-- unanswerable for exactly the rows a dispute is about.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_subscription_ref" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_customer_ref" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_plan_ref" text;

--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "provider_payment_ref" text;
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD COLUMN IF NOT EXISTS "provider_order_ref" text;

--> statement-breakpoint
ALTER TABLE "platform_payments" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "platform_payments" ADD COLUMN IF NOT EXISTS "provider_payment_ref" text;
--> statement-breakpoint
ALTER TABLE "platform_payments" ADD COLUMN IF NOT EXISTS "provider_order_ref" text;
--> statement-breakpoint
ALTER TABLE "platform_payments" ADD COLUMN IF NOT EXISTS "provider_signature" text;

--> statement-breakpoint
-- Every existing row is Razorpay's, so say so rather than leaving it null: an
-- unanswerable "which provider was this?" is worst for exactly the rows a
-- dispute is about.
UPDATE "subscriptions"
SET "provider" = 'razorpay',
    "provider_subscription_ref" = COALESCE("provider_subscription_ref", "razorpay_subscription_id"),
    "provider_customer_ref" = COALESCE("provider_customer_ref", "razorpay_customer_id"),
    "provider_plan_ref" = COALESCE("provider_plan_ref", "razorpay_plan_id")
WHERE "provider" IS NULL;

--> statement-breakpoint
UPDATE "subscription_payments"
SET "provider" = 'razorpay',
    "provider_payment_ref" = COALESCE("provider_payment_ref", "razorpay_payment_id"),
    "provider_order_ref" = COALESCE("provider_order_ref", "razorpay_order_id")
WHERE "provider" IS NULL;

--> statement-breakpoint
UPDATE "platform_payments"
SET "provider" = 'razorpay',
    "provider_payment_ref" = COALESCE("provider_payment_ref", "razorpay_payment_id"),
    "provider_order_ref" = COALESCE("provider_order_ref", "razorpay_order_id"),
    "provider_signature" = COALESCE("provider_signature", "razorpay_signature")
WHERE "provider" IS NULL;

--> statement-breakpoint
-- The uniqueness that made a duplicate webhook delivery idempotent has to hold
-- on the new column too, or the second provider gets no protection at all.
-- Partial, because the column is nullable until the contract migration.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subscription_payments_provider_ref"
  ON "subscription_payments" ("provider", "provider_payment_ref")
  WHERE "provider_payment_ref" IS NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_platform_payments_provider_ref"
  ON "platform_payments" ("provider", "provider_payment_ref")
  WHERE "provider_payment_ref" IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscriptions_provider_ref"
  ON "subscriptions" ("provider", "provider_subscription_ref");

--> statement-breakpoint
ANALYZE "subscriptions";
--> statement-breakpoint
ANALYZE "subscription_payments";
--> statement-breakpoint
ANALYZE "platform_payments";
