ALTER TABLE "support_routing_rules" ADD COLUMN IF NOT EXISTS "assignment_mode" text DEFAULT 'static' NOT NULL;
ALTER TABLE "support_routing_rules" ADD COLUMN IF NOT EXISTS "candidate_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "first_response_due_at" timestamp;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "first_responded_at" timestamp;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "sla_paused_at" timestamp;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "sla_paused_minutes" integer DEFAULT 0 NOT NULL;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "sla_escalation_level" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "support_business_hours" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "weekly_schedule" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "holidays" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_24x7" boolean NOT NULL DEFAULT false,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_business_hours" ADD CONSTRAINT "support_business_hours_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_support_business_hours_org" ON "support_business_hours" ("org_id");

CREATE TABLE IF NOT EXISTS "support_sla_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "priority" "support_ticket_priority",
  "category" text,
  "business_hours_id" integer,
  "first_response_target_mins" integer NOT NULL,
  "resolution_target_mins" integer NOT NULL,
  "pause_statuses" jsonb NOT NULL DEFAULT '["WAITING"]'::jsonb,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "support_sla_policies" ADD CONSTRAINT "support_sla_policies_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_support_sla_policies_org_enabled" ON "support_sla_policies" ("org_id", "is_enabled");
