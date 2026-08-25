-- Custom SQL migration file, put your code below! --

-- Where each mailbox's sync got to.
--
-- Push tells you a message arrived; it does not tell you about the one that
-- arrived while the webhook endpoint was down, or during a deploy, or the three
-- the provider silently dropped. So push is the fast path and this watermark is
-- the truth: a sweep reads from `synced_through` forward and closes whatever gap
-- exists, and the ingress seam's idempotency makes the overlap free.
--
-- Storing a timestamp rather than a provider cursor on purpose. A cursor is
-- opaque and provider-specific and becomes invalid on re-authorisation, which
-- is exactly when a gap is most likely — a timestamp survives reconnecting the
-- same mailbox, which is what "without losing history or duplicating messages"
-- requires.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_mailbox_sync" (
  "crm_mailbox_sync_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- The connection this follows, from user_integration_connections.
  "connection_id" integer NOT NULL,
  "mailbox_address" text NOT NULL,
  "provider" text NOT NULL,

  -- Everything at or before this has been offered to the seam.
  "synced_through" timestamp,
  "last_run_at" timestamp,
  "last_error" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,

  -- A person can stop a mailbox feeding the CRM without disconnecting it from
  -- the rest of the product, which is a different decision.
  "enabled" boolean DEFAULT true NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_mailbox_sync" ADD CONSTRAINT "chk_crm_mailbox_sync_provider"
  CHECK ("provider" IN ('gmail', 'outlook'));

--> statement-breakpoint
ALTER TABLE "crm_mailbox_sync" ADD CONSTRAINT "fk_crm_mailbox_sync_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_mailbox_sync" VALIDATE CONSTRAINT "fk_crm_mailbox_sync_org";

--> statement-breakpoint
-- One watermark per mailbox. Two would race and each would think the other's
-- progress was a gap, re-offering the same messages forever.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_mailbox_sync_connection"
  ON "crm_mailbox_sync" ("organization_id", "connection_id");

--> statement-breakpoint
-- What the sweep picks up: enabled, oldest first.
CREATE INDEX IF NOT EXISTS "idx_crm_mailbox_sync_due"
  ON "crm_mailbox_sync" ("organization_id", "last_run_at")
  WHERE "enabled" = true;

--> statement-breakpoint
ALTER TABLE "crm_mailbox_sync" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_mailbox_sync";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_mailbox_sync"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_mailbox_sync" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_mailbox_sync" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_mailbox_sync";
