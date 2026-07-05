-- Tenant-facing payment provider setup (12_Payment_Integration_Setup_Page.md).
-- Hand-authored and applied directly via psql — see 0147_onboarding_flow_tables.sql for why
-- (drizzle-kit push bundles in unrelated pre-existing schema drift that isn't safe to auto-resolve).
-- Deliberately separate from subscriptions/subscription_payments and
-- platform_subscriptions/platform_payments (StreamlineOS billing tenants for their own SaaS
-- plan) — this is for tenants connecting their own Razorpay/Stripe account to charge their own
-- customers.

BEGIN;

CREATE TYPE "payment_environment" AS ENUM ('test', 'live');
CREATE TYPE "payment_provider_status" AS ENUM ('not_configured', 'test_mode_ready', 'needs_credentials', 'needs_business_details', 'needs_kyc', 'kyc_pending', 'kyc_rejected', 'needs_webhook', 'webhook_failing', 'test_payment_required', 'ready_for_live', 'live', 'degraded', 'disabled');
CREATE TYPE "payment_webhook_endpoint_status" AS ENUM ('not_verified', 'verified', 'failing');
CREATE TYPE "payment_webhook_processing_status" AS ENUM ('received', 'processed', 'failed', 'ignored_duplicate');
CREATE TYPE "payment_test_transaction_status" AS ENUM ('created', 'pending', 'succeeded', 'failed');
CREATE TYPE "payment_manual_method_status" AS ENUM ('enabled', 'missing_instructions', 'disabled');

CREATE TABLE "payment_providers" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  "display_name" text NOT NULL,
  "status" "payment_provider_status" NOT NULL DEFAULT 'not_configured',
  "environment" "payment_environment" NOT NULL DEFAULT 'test',
  "is_primary" boolean NOT NULL DEFAULT false,
  "supported_currencies" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "supported_payment_methods" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_providers_org_provider_key" UNIQUE ("org_id", "provider_key")
);
CREATE INDEX "idx_payment_providers_org" ON "payment_providers" ("org_id");

CREATE TABLE "payment_provider_accounts" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_id" integer NOT NULL REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "provider_account_id" text,
  "business_type" text,
  "country" text,
  "default_currency" text,
  "kyc_status" text,
  "requirements_due" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "payout_status" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_provider_accounts_provider" UNIQUE ("provider_id")
);

CREATE TABLE "payment_provider_credentials" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_id" integer NOT NULL REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "environment" "payment_environment" NOT NULL,
  "key_id" text,
  "secret_ref" text,
  "webhook_secret_ref" text,
  "masked_key_hint" text,
  "last_rotated_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_provider_credentials_provider_env" UNIQUE ("provider_id", "environment")
);

CREATE TABLE "payment_webhook_endpoints" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_id" integer NOT NULL REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "environment" "payment_environment" NOT NULL,
  "url" text NOT NULL,
  "expected_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" "payment_webhook_endpoint_status" NOT NULL DEFAULT 'not_verified',
  "last_verified_at" timestamp,
  "last_failure_at" timestamp,
  "failure_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_webhook_endpoints_provider_env" UNIQUE ("provider_id", "environment")
);

CREATE TABLE "payment_webhook_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_id" integer NOT NULL REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "environment" "payment_environment" NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "signature_valid" boolean NOT NULL,
  "processing_status" "payment_webhook_processing_status" NOT NULL DEFAULT 'received',
  "idempotency_key" text NOT NULL,
  "related_invoice_id" integer,
  "related_subscription_id" text,
  "payload_redacted" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "received_at" timestamp NOT NULL DEFAULT now(),
  "processed_at" timestamp,
  "error_message" text,
  CONSTRAINT "uq_payment_webhook_events_provider_env_event" UNIQUE ("provider_id", "environment", "provider_event_id")
);
CREATE INDEX "idx_payment_webhook_events_org" ON "payment_webhook_events" ("org_id", "received_at");

CREATE TABLE "payment_test_transactions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_id" integer NOT NULL REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "environment" "payment_environment" NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,
  "status" "payment_test_transaction_status" NOT NULL DEFAULT 'created',
  "provider_order_id" text,
  "provider_payment_id" text,
  "signature_verified" boolean NOT NULL DEFAULT false,
  "webhook_received" boolean NOT NULL DEFAULT false,
  "result_summary" text,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_payment_test_transactions_org" ON "payment_test_transactions" ("org_id", "provider_id");

CREATE TABLE "payment_audit_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "provider_id" integer REFERENCES "payment_providers"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "environment" "payment_environment",
  "before_redacted" jsonb,
  "after_redacted" jsonb,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_payment_audit_events_org" ON "payment_audit_events" ("org_id", "created_at");

CREATE TABLE "payment_manual_methods" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "method_type" text NOT NULL,
  "display_name" text NOT NULL,
  "instructions" text,
  "bank_name" text,
  "account_holder" text,
  "masked_account_number" text,
  "ifsc_swift_iban" text,
  "upi_id" text,
  "payment_reference_instructions" text,
  "require_manual_approval" boolean NOT NULL DEFAULT true,
  "status" "payment_manual_method_status" NOT NULL DEFAULT 'missing_instructions',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_payment_manual_methods_org_type" UNIQUE ("org_id", "method_type")
);

COMMIT;
