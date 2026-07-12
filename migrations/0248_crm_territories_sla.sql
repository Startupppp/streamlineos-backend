ALTER TABLE "territories" ADD COLUMN IF NOT EXISTS "criteria" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "territories" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 0 NOT NULL;

ALTER TABLE "crm_sla_policies" ADD COLUMN IF NOT EXISTS "conditions" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "crm_sla_policies" ADD COLUMN IF NOT EXISTS "target_minutes" integer;
ALTER TABLE "crm_sla_policies" ADD COLUMN IF NOT EXISTS "business_hours" boolean DEFAULT false NOT NULL;
ALTER TABLE "crm_sla_policies" ADD COLUMN IF NOT EXISTS "applies_to_text" text;
ALTER TABLE "crm_sla_policies" ADD COLUMN IF NOT EXISTS "priority_text" text;

ALTER TABLE "lead_assignment_rules" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "lead_assignment_rules" ADD COLUMN IF NOT EXISTS "assignment_type_text" text;

CREATE TABLE IF NOT EXISTS "crm_sla_breach_log" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "lead_id" integer NOT NULL,
  "policy_id" integer,
  "breached_at" timestamptz DEFAULT NOW() NOT NULL,
  "task_created" boolean DEFAULT false NOT NULL,
  "notified" boolean DEFAULT false NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_sla_breach_log_lead_policy_unique'
  ) THEN
    ALTER TABLE "crm_sla_breach_log" ADD CONSTRAINT "crm_sla_breach_log_lead_policy_unique" UNIQUE ("lead_id", "policy_id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_sla_breach_org" ON "crm_sla_breach_log"("org_id");
CREATE INDEX IF NOT EXISTS "idx_sla_breach_lead" ON "crm_sla_breach_log"("lead_id");
CREATE INDEX IF NOT EXISTS "idx_territories_org_priority" ON "territories"("org_id", "priority" DESC);
