SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_purchases" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "created_by_user_id" text,
  "provider_key" varchar(50) NOT NULL,
  "environment" varchar(10) NOT NULL,
  "merchant_key_id" varchar(120) NOT NULL,
  "provider_order_id" text NOT NULL,
  "plan" "subscription_plan" NOT NULL,
  "billing_cycle" varchar(10) NOT NULL,
  "catalog_version" integer,
  "base_amount_minor" integer NOT NULL,
  "discount_amount_minor" integer NOT NULL DEFAULT 0,
  "amount_minor" integer NOT NULL,
  "currency" varchar(3) NOT NULL,
  "coupon_id" integer,
  "status" varchar(20) NOT NULL DEFAULT 'PENDING',
  "provider_payment_id" text,
  "captured_amount_minor" integer,
  "captured_currency" varchar(3),
  "subscription_id" integer,
  "activated_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_subscription_purchases_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_subscription_purchases_order" UNIQUE ("provider_order_id"),
  CONSTRAINT "fk_subscription_purchases_org"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_subscription_purchases_user"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "fk_subscription_purchases_coupon"
    FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subscription_purchases_payment_id"
  ON "subscription_purchases" ("provider_payment_id")
  WHERE "provider_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_purchases_org_status"
  ON "subscription_purchases" ("org_id", "status", "created_at" DESC);
