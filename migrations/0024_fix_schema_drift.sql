-- Migration 0024: Fix schema drift
-- Adds columns that exist in the Drizzle schema but were missing from migration files.
-- All statements use IF NOT EXISTS so this is fully idempotent.

-- notifications: channel + sound were added to schema via db:push only, never via migration
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'in_app';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "sound" boolean DEFAULT false;

-- users: google OAuth + TOTP fields (0017 / 0023 might not be applied)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_refresh_token" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_email" text;

-- calendar_events: location column (migration 0022)
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "location" text;

-- user_sessions table (migration 0021)
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "user_agent" text,
  "ip_address" text,
  "is_revoked" boolean DEFAULT false NOT NULL,
  "last_active" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_user_sessions_user_active" ON "user_sessions" ("user_id", "is_revoked", "created_at");

-- api_keys table (migration 0021)
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "description" text,
  "is_revoked" boolean DEFAULT false NOT NULL,
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_api_keys_org_active" ON "api_keys" ("org_id", "is_revoked");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_keys_key_prefix" ON "api_keys" ("key_prefix");

-- password_history table (migration 0020)
CREATE TABLE IF NOT EXISTS "password_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "password_hash" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_password_history_user" ON "password_history" ("user_id", "created_at");

-- calendar_events table (migration 0018) — create if missing
CREATE TABLE IF NOT EXISTS "calendar_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" text,
  "location" text,
  "start_date" timestamp NOT NULL,
  "end_date" timestamp NOT NULL,
  "all_day" boolean DEFAULT false,
  "color" text,
  "category" text NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "attendee_ids" jsonb DEFAULT '[]',
  "is_recurring" boolean DEFAULT false,
  "recurring_rule" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_calendar_events_org_date" ON "calendar_events" ("org_id", "start_date");
CREATE INDEX IF NOT EXISTS "idx_calendar_events_category" ON "calendar_events" ("category");
CREATE INDEX IF NOT EXISTS "idx_calendar_events_created_by" ON "calendar_events" ("created_by");

-- notification_preferences table (if missing)
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL UNIQUE REFERENCES "users"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "email_enabled" boolean DEFAULT true,
  "push_enabled" boolean DEFAULT true,
  "sms_enabled" boolean DEFAULT false,
  "in_app_enabled" boolean DEFAULT true,
  "quiet_hours_start" text,
  "quiet_hours_end" text,
  "categories" jsonb DEFAULT '{}',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- push_subscriptions table (if missing)
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "endpoint" text NOT NULL UNIQUE,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_push_subs_user" ON "push_subscriptions" ("user_id");
