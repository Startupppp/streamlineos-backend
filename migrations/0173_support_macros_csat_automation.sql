ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'ticket.priority_changed';
ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'ticket.message_received';

ALTER TABLE "support_macros" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'org' NOT NULL;
ALTER TABLE "support_macros" ADD COLUMN IF NOT EXISTS "actions" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "support_macros" ADD COLUMN IF NOT EXISTS "usage_count" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "support_csat_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "ticket_id" integer NOT NULL,
  "token" text NOT NULL,
  "score" integer,
  "comment" text,
  "responded_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "support_csat_requests" ADD CONSTRAINT "support_csat_requests_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "support_csat_requests" ADD CONSTRAINT "support_csat_requests_ticket_id_support_tickets_id_fk"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_csat_requests_token" ON "support_csat_requests" ("token");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_csat_requests_ticket" ON "support_csat_requests" ("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_support_csat_requests_org" ON "support_csat_requests" ("org_id");
