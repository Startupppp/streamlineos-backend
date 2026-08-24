-- Custom SQL migration file, put your code below! --

-- Ticket 10. The receipt for one delivery from outside.
--
-- A provider delivers at least once and often more: a webhook retry, a reconnect
-- replaying a backlog, an operator re-running an import. Without this table the
-- second delivery of a message creates a second party, a second activity and a
-- second follow-up task.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_events" (
  "inbound_event_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "channel" text NOT NULL,
  "provider" text NOT NULL,
  "provider_message_id" text NOT NULL,
  "provider_thread_id" text,
  "status" text DEFAULT 'RECEIVED' NOT NULL,
  "workflow_run_id" text,
  "payload" jsonb NOT NULL,
  "party_id" text,
  "activity_id" text,
  "error" text,
  "occurred_at" timestamp NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp
);

--> statement-breakpoint
-- The exactly-once key. Scoped by organisation as well as provider: a message id
-- is unique within a provider, not across tenants, and a global key would let one
-- organisation's delivery suppress another's.
ALTER TABLE "inbound_events" ADD CONSTRAINT "uniq_inbound_events_delivery"
  UNIQUE ("organization_id", "provider", "provider_message_id");

--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "chk_inbound_events_channel"
  CHECK ("channel" IN ('email', 'calendar', 'call', 'message'));

--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "chk_inbound_events_status"
  CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'FAILED'));

--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "fk_inbound_events_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "inbound_events" VALIDATE CONSTRAINT "fk_inbound_events_org";

--> statement-breakpoint
-- The operator read: what is stuck, newest first.
CREATE INDEX IF NOT EXISTS "idx_inbound_events_org_status"
  ON "inbound_events" ("organization_id", "status", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_events_thread"
  ON "inbound_events" ("organization_id", "provider_thread_id");

--> statement-breakpoint
-- The payload is the verbatim contents of somebody's mail, so a missing policy
-- here is not a tidiness problem.
ALTER TABLE "inbound_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inbound_events";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_events"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "inbound_events" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inbound_events" TO streamline_app;

--> statement-breakpoint
ANALYZE "inbound_events";
