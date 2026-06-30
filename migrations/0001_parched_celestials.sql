CREATE TYPE "public"."affiliate_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."ai_credit_txn_type" AS ENUM('PURCHASE', 'USAGE', 'REFUND', 'PLAN_GRANT', 'EXPIRY');--> statement-breakpoint
CREATE TYPE "public"."app_install_status" AS ENUM('TRIALING', 'ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('PENDING', 'APPROVED', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('PENDING', 'SIGNED_UP', 'ACTIVATED', 'REWARDED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."revenue_event_type" AS ENUM('new_subscription', 'upgrade', 'downgrade', 'churn', 'reactivation', 'addon_purchase', 'refund');--> statement-breakpoint
CREATE TABLE "affiliate_commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"affiliate_id" integer NOT NULL,
	"referred_org_id" integer NOT NULL,
	"subscription_id" integer,
	"amount_in_paise" integer NOT NULL,
	"status" "commission_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"referral_code" varchar(20) NOT NULL,
	"status" "affiliate_status" DEFAULT 'PENDING' NOT NULL,
	"commission_type" varchar(20) DEFAULT 'PERCENTAGE' NOT NULL,
	"commission_rate" integer DEFAULT 10 NOT NULL,
	"total_earned" integer DEFAULT 0 NOT NULL,
	"total_paid" integer DEFAULT 0 NOT NULL,
	"pending_payout" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"signup_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliates_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "affiliates_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "ai_credit_packs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"credits" integer NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"price_in_paise" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer,
	"type" "ai_credit_txn_type" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"feature" varchar(100),
	"model" varchar(100),
	"reference_id" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"app_id" integer NOT NULL,
	"installed_by" integer NOT NULL,
	"status" "app_install_status" DEFAULT 'ACTIVE' NOT NULL,
	"trial_ends_at" timestamp,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"gstin" varchar(15),
	"pan" varchar(10),
	"billing_name" varchar(255),
	"billing_email" varchar(255),
	"address_line1" text,
	"address_line2" text,
	"city" varchar(100),
	"state" varchar(100),
	"pincode" varchar(10),
	"country" varchar(2) DEFAULT 'IN',
	"is_tax_exempt" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_profiles_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "marketplace_apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"icon_url" text,
	"screenshot_urls" jsonb DEFAULT '[]'::jsonb,
	"features" jsonb DEFAULT '[]'::jsonb,
	"pricing_type" varchar(20) DEFAULT 'free' NOT NULL,
	"monthly_price" integer DEFAULT 0 NOT NULL,
	"annual_price" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"required_plan" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_apps_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "org_ai_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"lifetime_granted" integer DEFAULT 0 NOT NULL,
	"lifetime_consumed" integer DEFAULT 0 NOT NULL,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"auto_top_up_pack_id" integer,
	"auto_top_up_threshold" integer DEFAULT 100,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_ai_credits_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_org_id" integer NOT NULL,
	"referrer_user_id" integer NOT NULL,
	"referred_email" varchar(255) NOT NULL,
	"referred_org_id" integer,
	"referral_code" varchar(20) NOT NULL,
	"status" "referral_status" DEFAULT 'PENDING' NOT NULL,
	"reward_granted" boolean DEFAULT false NOT NULL,
	"signed_up_at" timestamp,
	"activated_at" timestamp,
	"rewarded_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "revenue_event_type" NOT NULL,
	"org_id" integer NOT NULL,
	"plan" varchar(20),
	"previous_plan" varchar(20),
	"mrr" integer NOT NULL,
	"amount" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "affiliate_commissions_affiliate_idx" ON "affiliate_commissions" USING btree ("affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_status_idx" ON "affiliate_commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "affiliates_code_idx" ON "affiliates" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "affiliates_user_idx" ON "affiliates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_credit_txns_org_idx" ON "ai_credit_transactions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ai_credit_txns_org_created_idx" ON "ai_credit_transactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "app_installations_org_app_idx" ON "app_installations" USING btree ("org_id","app_id");--> statement-breakpoint
CREATE INDEX "app_installations_org_idx" ON "app_installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "billing_profiles_org_idx" ON "billing_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "marketplace_apps_category_idx" ON "marketplace_apps" USING btree ("category");--> statement-breakpoint
CREATE INDEX "marketplace_apps_active_idx" ON "marketplace_apps" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "org_ai_credits_org_idx" ON "org_ai_credits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_org_id");--> statement-breakpoint
CREATE INDEX "referrals_code_idx" ON "referrals" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "referrals_email_idx" ON "referrals" USING btree ("referred_email");--> statement-breakpoint
CREATE INDEX "revenue_events_type_idx" ON "revenue_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "revenue_events_created_idx" ON "revenue_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "revenue_events_org_idx" ON "revenue_events" USING btree ("org_id");