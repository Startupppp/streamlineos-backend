-- Migration: 0044_deal_meetings
-- Adds deal_meetings table for S5 Meeting Notes feature

CREATE TABLE IF NOT EXISTS "deal_meetings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "deal_id" integer NOT NULL,
  "title" text NOT NULL,
  "scheduled_at" timestamp NOT NULL,
  "duration_minutes" integer DEFAULT 30,
  "attendees" text[],
  "agenda" text,
  "notes" text,
  "action_items" text,
  "recording_link" text,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "deal_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "deal_meetings_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "deal_meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "idx_deal_meetings_deal" ON "deal_meetings" ("deal_id");
CREATE INDEX IF NOT EXISTS "idx_deal_meetings_org" ON "deal_meetings" ("org_id");
