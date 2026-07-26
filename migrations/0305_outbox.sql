DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outbox_delivery_state') THEN
    CREATE TYPE "public"."outbox_delivery_state" AS ENUM ('PENDING', 'IN_FLIGHT', 'DELIVERED', 'DEAD', 'SUPPRESSED');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"outbox_event_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"event_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"causation_id" text,
	"correlation_id" text,
	"actor_membership_id" text,
	"audience" text DEFAULT 'INTERNAL' NOT NULL,
	"lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL,
	"delivery_state" "outbox_delivery_state" DEFAULT 'PENDING' NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"published_at" timestamp,
	"lease_expires_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dead_lettered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_records" (
	"inbox_record_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"producer_event_id" text NOT NULL,
	"consumer_name" text NOT NULL,
	"organization_id" text NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"processed_at" timestamp,
	"last_error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inbox_records" ADD CONSTRAINT "inbox_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outbox_events_event_id" ON "outbox_events" ("event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_outbox_events_org_agg_version" ON "outbox_events" ("organization_id","aggregate_type","aggregate_id","aggregate_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_events_claim" ON "outbox_events" ("delivery_state","lease_expires_at","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_events_org_state" ON "outbox_events" ("organization_id","delivery_state","occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inbox_consumer_event" ON "inbox_records" ("producer_event_id","consumer_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_org_status" ON "inbox_records" ("organization_id","status");
