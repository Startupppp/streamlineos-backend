-- Subscription & Billing Module
DO $$ BEGIN
  CREATE TYPE "public"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."subscription_plan" AS ENUM('STARTER', 'PROFESSIONAL', 'ENTERPRISE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "plan" "subscription_plan" DEFAULT 'STARTER' NOT NULL,
  "status" "subscription_status" DEFAULT 'TRIAL' NOT NULL,
  "razorpay_subscription_id" text,
  "razorpay_customer_id" text,
  "razorpay_plan_id" text,
  "current_period_start" timestamp,
  "current_period_end" timestamp,
  "trial_ends_at" timestamp,
  "cancelled_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "subscription_payments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subscription_id" integer NOT NULL REFERENCES "subscriptions"("id"),
  "razorpay_payment_id" text,
  "razorpay_order_id" text,
  "amount" numeric(12, 2) NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "status" text NOT NULL,
  "paid_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_subscriptions_org" ON "subscriptions" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_status" ON "subscriptions" ("status");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_razorpay" ON "subscriptions" ("razorpay_subscription_id");
CREATE INDEX IF NOT EXISTS "idx_sub_payments_org" ON "subscription_payments" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_sub_payments_sub" ON "subscription_payments" ("subscription_id");
