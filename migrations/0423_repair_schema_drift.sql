-- 0423: repair measured drift between the live database and the Drizzle schema.
--
-- Found by comparing the code-derived snapshot against pg_catalog, not by reading
-- migrations. Three independent causes:
--
--  1. 0352_custom_fields_consolidation DROPPED ticket_custom_field_values and
--     support_ticket_custom_field_values and then died partway through recreating them,
--     yet was still recorded as applied. Both tables are declared in schema and queried
--     by build/core/projects-custom-fields.service.ts and
--     support/core/support-custom-fields.service.ts, so every ticket custom-field read
--     and write has been failing with "relation does not exist". Recreated from that
--     migration's own DDL.
--
--  2. The CRM consent tables/enums and dunning_attempts are committed, service-referenced
--     schema that never had a migration written at all. DDL below is generated from the
--     Drizzle schema so it cannot drift from the code.
--
--  3. Nine tenant-scoped tables had RLS never enabled. Table grants are handed out by
--     ALTER DEFAULT PRIVILEGES, so streamline_app could already read them -- with no
--     policy that is a cross-tenant read of every org's rows. Fixed for all nine plus
--     the five created here.
--
-- Additive only: no DROP, no data change. Reversible via the companion .down.sql.

SET lock_timeout = '5s';
--> statement-breakpoint

-- ─── 1. tables 0352 dropped and failed to recreate (DDL copied from 0352 verbatim) ───
CREATE TABLE IF NOT EXISTS "ticket_custom_field_values" (
  "id"                   SERIAL PRIMARY KEY,
  "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ticket_id"            INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "value"                TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ticket_custom_field_values" ON "ticket_custom_field_values" ("ticket_id", "field_definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_custom_field_values_ticket" ON "ticket_custom_field_values" ("ticket_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tcfv_org_id" ON "ticket_custom_field_values" ("org_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_ticket_custom_field_values" (
  "id"                   SERIAL PRIMARY KEY,
  "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ticket_id"            INTEGER NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "value"                TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_custom_field_values_ticket_field" ON "support_ticket_custom_field_values" ("ticket_id", "field_definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_ticket_custom_field_values_org_ticket" ON "support_ticket_custom_field_values" ("org_id", "ticket_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_stcfv_org_id" ON "support_ticket_custom_field_values" ("org_id", "id");
--> statement-breakpoint

-- ─── 2. schema that never had a migration (DDL generated from the Drizzle schema) ───
DO $$ BEGIN
  CREATE TYPE "public"."crm_consent_channel" AS ENUM('EMAIL', 'SMS', 'WHATSAPP', 'PHONE', 'POST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."crm_consent_status" AS ENUM('OPTED_IN', 'OPTED_OUT', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."crm_consent_source" AS ENUM('USER_ENTRY', 'IMPORT', 'WEB_FORM', 'UNSUBSCRIBE_LINK', 'API', 'ENRICHMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."crm_legal_basis" AS ENUM('CONSENT', 'CONTRACT', 'LEGITIMATE_INTEREST', 'LEGAL_OBLIGATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_contact_channel_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" integer NOT NULL,
	"channel" "crm_consent_channel" NOT NULL,
	"status" "crm_consent_status" DEFAULT 'UNKNOWN' NOT NULL,
	"legal_basis" "crm_legal_basis",
	"source" "crm_consent_source" DEFAULT 'USER_ENTRY' NOT NULL,
	"source_detail" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_crm_consent_org_id" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_contact_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" integer NOT NULL,
	"channel" "crm_consent_channel" NOT NULL,
	"from_status" "crm_consent_status",
	"to_status" "crm_consent_status" NOT NULL,
	"legal_basis" "crm_legal_basis",
	"source" "crm_consent_source" NOT NULL,
	"source_detail" text,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_crm_consent_events_org_id" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dunning_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dunning_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"subscription_id" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"milestone" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"outcome" text,
	"notification_ref" text,
	"provider_retry_id" text,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_dunning_attempts_org_id" UNIQUE("org_id","id"),
	CONSTRAINT "chk_dunning_milestone" CHECK ("dunning_attempts"."milestone" IN ('D+1','D+3','D+7','D+14')),
	CONSTRAINT "chk_dunning_status" CHECK ("dunning_attempts"."status" IN ('PENDING','SENT','FAILED','SKIPPED')),
	CONSTRAINT "chk_dunning_outcome" CHECK ("dunning_attempts"."outcome" IS NULL OR "dunning_attempts"."outcome" IN ('PAYMENT_RECEIVED','NO_RESPONSE','BOUNCED','CANCELLED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dunning_attempts" ADD CONSTRAINT "dunning_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dunning_attempts" ADD CONSTRAINT "dunning_attempts_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_consent_org_contact" ON "crm_contact_channel_consent" USING btree ("org_id","contact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_consent_org_channel_status" ON "crm_contact_channel_consent" USING btree ("org_id","channel","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_consent_org_contact_channel" ON "crm_contact_channel_consent" USING btree ("org_id","contact_id","channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_consent_events_org_contact" ON "crm_contact_consent_events" USING btree ("org_id","contact_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_consent_events_org_created" ON "crm_contact_consent_events" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_dunning_attempt_cycle_milestone" ON "dunning_attempts" USING btree ("org_id","subscription_id","period_start","milestone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dunning_attempts_org_sub_period" ON "dunning_attempts" USING btree ("org_id","subscription_id","period_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dunning_attempts_pending_milestone" ON "dunning_attempts" USING btree ("milestone","org_id") WHERE status = 'PENDING';
--> statement-breakpoint

-- ─── 3. columns declared in schema but absent from the database ───
ALTER TABLE "notification_audit_logs" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notification_audit_logs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN IF NOT EXISTS "amount_cents" bigint;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TYPE "public"."subscription_status" ADD VALUE IF NOT EXISTS 'SUSPENDED' BEFORE 'EXPIRED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ─── 4. tenant isolation: enable RLS + the standard policy, and confirm the app grant ───
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_custom_field_values','support_ticket_custom_field_values','crm_contact_channel_consent','crm_contact_consent_events','dunning_attempts','legal_entities','managed_product_releases','inv_average_cost_history','inv_barcodes','inv_product_uom_conversions','inv_reason_codes','inv_standard_costs','inv_user_warehouses','inv_valuation_consumptions'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO streamline_app', t);
  END LOOP;
END $$;
