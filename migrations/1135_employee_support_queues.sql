-- 1135: employee support queues on the helpdesk ticket entity.
--
-- The HR helpdesk becomes the company-wide employee support surface: a ticket
-- carries the queue it was routed to (HR | IT | FINANCE | ADMIN | LEGAL), a
-- first-response due stamp beside the existing resolution due stamp, and an
-- escalation marker the cron sweep sets once. Per-queue SLA hours and the
-- escalation target live in helpdesk_queues, one row per (org, queue); a queue
-- with no row falls back to the defaults in code. Category -> queue overrides
-- reuse hr_helpdesk_routing, whose assignee becomes optional so a rule may name
-- a queue, a person, or both.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "helpdesk_queue" AS ENUM ('HR', 'IT', 'FINANCE', 'ADMIN', 'LEGAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "queue" "helpdesk_queue" NOT NULL DEFAULT 'HR';
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "first_response_due_at" timestamp;
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "first_responded_at" timestamp;
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "escalation_level" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_queue_status_created"
  ON "helpdesk_tickets" ("org_id", "queue", "status", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_helpdesk_tickets_org_escalation_due"
  ON "helpdesk_tickets" ("org_id", "sla_due_at")
  WHERE "escalation_level" = 0 AND "status" <> 'DONE';
--> statement-breakpoint

ALTER TABLE "hr_helpdesk_routing" ADD COLUMN IF NOT EXISTS "queue" "helpdesk_queue";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ALTER COLUMN "assignee_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" DROP CONSTRAINT IF EXISTS "chk_hr_helpdesk_routing_target";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ADD CONSTRAINT "chk_hr_helpdesk_routing_target"
  CHECK ("queue" IS NOT NULL OR "assignee_user_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" VALIDATE CONSTRAINT "chk_hr_helpdesk_routing_target";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" DROP CONSTRAINT IF EXISTS "fk_hr_helpdesk_routing_assignee_actor";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ADD CONSTRAINT "fk_hr_helpdesk_routing_assignee_actor"
  FOREIGN KEY ("org_id", "assignee_membership_id") REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" VALIDATE CONSTRAINT "fk_hr_helpdesk_routing_assignee_actor";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "helpdesk_queues" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "queue" "helpdesk_queue" NOT NULL,
  "first_response_hours" integer NOT NULL,
  "resolution_hours" integer NOT NULL,
  "escalation_user_id" text,
  "escalation_membership_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_helpdesk_queues_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_helpdesk_queues_hours" CHECK ("first_response_hours" > 0 AND "resolution_hours" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_helpdesk_queues_org_queue" ON "helpdesk_queues" ("org_id", "queue");
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" DROP CONSTRAINT IF EXISTS "helpdesk_queues_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" ADD CONSTRAINT "helpdesk_queues_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" VALIDATE CONSTRAINT "helpdesk_queues_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" DROP CONSTRAINT IF EXISTS "helpdesk_queues_escalation_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" ADD CONSTRAINT "helpdesk_queues_escalation_user_id_users_id_fk"
  FOREIGN KEY ("escalation_user_id") REFERENCES "users" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" VALIDATE CONSTRAINT "helpdesk_queues_escalation_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" DROP CONSTRAINT IF EXISTS "fk_helpdesk_queues_escalation_actor";
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" ADD CONSTRAINT "fk_helpdesk_queues_escalation_actor"
  FOREIGN KEY ("org_id", "escalation_membership_id") REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("escalation_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "helpdesk_queues" VALIDATE CONSTRAINT "fk_helpdesk_queues_escalation_actor";
--> statement-breakpoint

ALTER TABLE "helpdesk_queues" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "helpdesk_queues";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "helpdesk_queues"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "helpdesk_queues" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "helpdesk_queues_id_seq" TO streamline_app;
