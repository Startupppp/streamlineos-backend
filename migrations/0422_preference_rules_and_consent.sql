-- 0422: SCH-003 and COMP-003.
--
-- SCH-003  notification_preferences stored per-event, per-module and per-category
--          settings in four JSONB blobs (`categories`, `channel_categories`,
--          `event_preferences`, `module_preferences`). They cannot be indexed, cannot
--          answer "who has payroll email on", cannot be toggled atomically, and defeat
--          any server-side preference centre. §19 bans JSONB for lifecycle state.
--          Free to fix now: the table holds 0 rows (verified immediately before).
--
--          `channel` is NOT NULL with one row per channel rather than a nullable
--          "all channels" row — a NULL in a unique index enforces nothing, which is
--          the same defect found in SCH-013 and fixed in 0415. Absence of a rule means
--          "fall through to the header defaults", which is what makes conservative
--          defaults expressible at all.
--
-- COMP-003 Nothing recorded consent. `notification_preferences` holds booleans, which
--          is a setting, not a consent record: no source, no timestamp, no legal basis,
--          no immutable history. SMS and WhatsApp cannot legally ship without this, and
--          a mutable `state` column alone cannot answer "when and how did they agree",
--          so the current state and the event log are separate tables.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "notification_preference_rules" (
  "id"         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"     text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id"    text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "scope_type" text NOT NULL,
  "scope_key"  text NOT NULL,
  "channel"    "notification_channel" NOT NULL,
  "mode"       text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_pref_rule"
  ON "notification_preference_rules" ("org_id","user_id","scope_type","scope_key","channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_pref_rule_lookup"
  ON "notification_preference_rules" ("org_id","user_id","scope_type","scope_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_preference_rules_org_id"
  ON "notification_preference_rules" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "notification_preference_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_preference_rules";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_preference_rules"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- Postgres has no CREATE TYPE IF NOT EXISTS, and every other object in this file is
-- already guarded, so an unguarded enum is the one statement that makes the migration
-- non-rerunnable.
DO $$ BEGIN
  CREATE TYPE "notification_consent_state"  AS ENUM ('GRANTED','WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_consent_source" AS ENUM ('USER','ADMIN','IMPORT','SIGNUP','API');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_legal_basis"    AS ENUM ('CONSENT','CONTRACT','LEGITIMATE_INTEREST','LEGAL_OBLIGATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_consents" (
  "id"           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id"      text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "channel"      "notification_channel" NOT NULL,
  "destination"  text NOT NULL,
  "state"        "notification_consent_state" NOT NULL,
  "source"       "notification_consent_source" NOT NULL,
  "legal_basis"  "notification_legal_basis" NOT NULL,
  "ip"           text,
  "user_agent"   text,
  "granted_at"   timestamp with time zone,
  "withdrawn_at" timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_consents_current"
  ON "notification_consents" ("org_id","user_id","channel","destination");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_consents_org_id"
  ON "notification_consents" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "notification_consents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_consents";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_consents"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- Append-only. §20 requires consent grants and withdrawals to be logged immutably,
-- which a table with a mutable `state` column cannot do on its own.
CREATE TABLE IF NOT EXISTS "notification_consent_events" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id"     text NOT NULL,
  "channel"     "notification_channel" NOT NULL,
  "destination" text NOT NULL,
  "state"       "notification_consent_state" NOT NULL,
  "source"      "notification_consent_source" NOT NULL,
  "legal_basis" "notification_legal_basis" NOT NULL,
  "ip"          text,
  "user_agent"  text,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_consent_events_subject"
  ON "notification_consent_events" ("org_id","user_id","channel","occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_consent_events_org_id"
  ON "notification_consent_events" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "notification_consent_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_consent_events";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_consent_events"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
