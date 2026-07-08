-- Notifications delivery engine: event registry, per-channel deliveries, work queue,
-- policy defaults, provider accounts, suppression rules, digests. Additive only.

ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'CHAT';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'PAYROLL';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'RECRUITMENT';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'KNOWLEDGE';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'SIGN';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'INVENTORY';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'SURVEYS';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'CALENDAR';--> statement-breakpoint
ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'SUPPORT';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "notification_delivery_status" AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'CLICKED', 'FAILED', 'BOUNCED', 'SUPPRESSED', 'CANCELLED', 'DEAD');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_queue_status" AS ENUM ('PENDING', 'LOCKED', 'DONE', 'FAILED', 'DEAD');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_policy_scope" AS ENUM ('ORG', 'ROLE', 'DEPARTMENT', 'TEAM', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_provider" AS ENUM ('SMTP', 'SENDGRID', 'TWILIO', 'META_WHATSAPP', 'SLACK', 'TEAMS', 'WEBHOOK', 'WEB_PUSH', 'INTERNAL', 'SANDBOX');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_quiet_hours_behavior" AS ENUM ('respect', 'bypass_if_high', 'always_bypass');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_suppression_reason" AS ENUM ('DEDUPE', 'MUTE', 'UNSUBSCRIBE', 'INVALID_RECIPIENT', 'RATE_LIMIT', 'QUIET_HOURS', 'NO_PROVIDER', 'CONSENT_MISSING', 'CHANNEL_DISABLED', 'COST_LIMIT');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "event_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "entity_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "entity_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "actor_user_id" text REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "group_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_dedupe" ON "notifications" ("org_id", "event_key", "entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_group" ON "notifications" ("user_id", "group_key");--> statement-breakpoint

ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_channel" text NOT NULL DEFAULT 'EMAIL';--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_time" text;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "quiet_hours_weekends" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "allow_critical_override" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "event_preferences" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "module_preferences" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "priority_preferences" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "updated_by" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text REFERENCES "organizations"("id") ON DELETE cascade,
  "event_key" text NOT NULL,
  "source_module" text NOT NULL,
  "category" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "default_priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
  "default_type" "notification_type" NOT NULL DEFAULT 'INFO',
  "default_channels" jsonb NOT NULL DEFAULT '["IN_APP"]'::jsonb,
  "allowed_channels" jsonb NOT NULL DEFAULT '["IN_APP"]'::jsonb,
  "mandatory" boolean NOT NULL DEFAULT false,
  "user_configurable" boolean NOT NULL DEFAULT true,
  "admin_configurable" boolean NOT NULL DEFAULT true,
  "quiet_hours_behavior" "notification_quiet_hours_behavior" NOT NULL DEFAULT 'respect',
  "dedupe_window_seconds" integer NOT NULL DEFAULT 0,
  "rate_limit_window_seconds" integer NOT NULL DEFAULT 0,
  "rate_limit_max" integer NOT NULL DEFAULT 0,
  "template_key" text,
  "audience_resolver" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_events_org_key" ON "notification_events" ("org_id", "event_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_events_module" ON "notification_events" ("source_module");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_events_category" ON "notification_events" ("category");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" serial PRIMARY KEY NOT NULL,
  "notification_id" integer REFERENCES "notifications"("id") ON DELETE cascade,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "event_key" text,
  "channel" "notification_channel" NOT NULL,
  "provider" "notification_provider",
  "recipient_address" text,
  "status" "notification_delivery_status" NOT NULL DEFAULT 'PENDING',
  "priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "next_attempt_at" timestamp,
  "sent_at" timestamp,
  "delivered_at" timestamp,
  "read_at" timestamp,
  "clicked_at" timestamp,
  "failed_at" timestamp,
  "failure_code" text,
  "failure_message" text,
  "suppression_reason" "notification_suppression_reason",
  "provider_message_id" text,
  "provider_response" jsonb,
  "cost_amount" integer NOT NULL DEFAULT 0,
  "cost_currency" text NOT NULL DEFAULT 'USD',
  "idempotency_key" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_deliveries_idempotency" ON "notification_deliveries" ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_due" ON "notification_deliveries" ("org_id", "status", "next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_notification" ON "notification_deliveries" ("notification_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_user_channel" ON "notification_deliveries" ("org_id", "user_id", "channel", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_event" ON "notification_deliveries" ("org_id", "event_key", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_queue" (
  "id" serial PRIMARY KEY NOT NULL,
  "delivery_id" integer NOT NULL REFERENCES "notification_deliveries"("id") ON DELETE cascade,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "channel" "notification_channel" NOT NULL,
  "run_at" timestamp NOT NULL DEFAULT now(),
  "status" "notification_queue_status" NOT NULL DEFAULT 'PENDING',
  "locked_by" text,
  "locked_at" timestamp,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_queue_due" ON "notification_queue" ("status", "run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_queue_delivery" ON "notification_queue" ("delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_queue_org" ON "notification_queue" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_policy_defaults" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "scope_type" "notification_policy_scope" NOT NULL,
  "scope_id" text,
  "default_channels" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "event_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "category_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "module_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "can_user_override" boolean NOT NULL DEFAULT true,
  "resolution_order" integer NOT NULL DEFAULT 0,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_policy_scope" ON "notification_policy_defaults" ("org_id", "scope_type", "scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_policy_org_scope" ON "notification_policy_defaults" ("org_id", "scope_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_provider_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "channel" "notification_channel" NOT NULL,
  "provider" "notification_provider" NOT NULL,
  "display_name" text NOT NULL,
  "config_encrypted" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "sandbox_mode" boolean NOT NULL DEFAULT true,
  "is_default" boolean NOT NULL DEFAULT false,
  "daily_send_limit" integer,
  "monthly_cost_limit" integer,
  "health_status" text NOT NULL DEFAULT 'unknown',
  "last_tested_at" timestamp,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_provider_name" ON "notification_provider_accounts" ("org_id", "provider", "display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_provider_channel" ON "notification_provider_accounts" ("org_id", "channel", "enabled");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_suppression_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text REFERENCES "users"("id") ON DELETE cascade,
  "scope_type" text NOT NULL,
  "scope_key" text NOT NULL,
  "channel" "notification_channel",
  "reason" "notification_suppression_reason" NOT NULL,
  "expires_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_suppression_lookup" ON "notification_suppression_rules" ("org_id", "user_id", "scope_type", "scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_suppression_expiry" ON "notification_suppression_rules" ("org_id", "expires_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_digests" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "digest_mode" text NOT NULL,
  "channel" "notification_channel" NOT NULL DEFAULT 'EMAIL',
  "period_start" timestamp NOT NULL,
  "period_end" timestamp NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "notification_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary" text,
  "sent_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_digests_user" ON "notification_digests" ("org_id", "user_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_digests_due" ON "notification_digests" ("status", "period_end");
