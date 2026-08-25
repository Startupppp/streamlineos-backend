-- Custom SQL migration file, put your code below! --

-- Direct connectors: where a read of somebody else's CRM has got to, and what
-- it has read but not yet planned.
--
-- Two tables, and the split is the whole resumption argument.
--
-- `crm_connector_syncs` holds two different pieces of progress that are
-- deliberately not the same column. `cursor` is where THIS WALK is -- the
-- provider's own next-page request, written in the same transaction as the page
-- it follows, so a run that dies mid-collection resumes instead of restarting.
-- `synced_through` is what has DEFINITELY been read, and it moves only when a
-- walk reaches the end of the collection.
--
-- That second rule is the mailbox lesson applied to a harder case. Mail has an
-- order, so "everything up to this instant" says something true about a partial
-- read. A CRM collection has no order this repository can rely on -- two of the
-- four providers guarantee none on their list endpoints -- so a half-finished
-- walk supports no claim about a time range at all. Advancing the watermark to
-- the newest record seen halfway through would put every older record the walk
-- had not reached below the floor, permanently. That is exactly how six days of
-- mail vanished, with a customer list instead of an inbox.
--
-- `crm_connector_records` stages what was read. It exists so a page is written
-- once and a resumed attempt does not have to carry tens of megabytes of
-- somebody else's CRM back through `workflow_steps` to reach the frontier. Its
-- unique index on `source_id` is the claim: a step that failed after writing
-- half a page rolls back, re-runs, and re-inserts ON CONFLICT DO NOTHING.
--
-- No column here references `users`. See 0223: `scripts/purge-user.mjs` deletes
-- every row whose column references `users` regardless of the delete rule, and
-- an offboarded admin must not take the record of a migration with them.
--
-- `connection_id` deliberately has NO foreign key to
-- `user_integration_connections`: that table mirrors Composio, is hard-deleted
-- on disconnect, and carries no tenant-composite key for a composite FK to
-- point at. A sync whose connection has gone reports "disconnected" and stops,
-- which is a better answer than a cascade that erases what was imported.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run
-- here. NOT APPLIED -- registered in the journal only.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_connector_syncs" (
  "crm_connector_sync_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  "connection_id" integer NOT NULL,
  "provider" text NOT NULL,
  "stream" text NOT NULL,

  -- Moves only when a walk drains. See above.
  "synced_through" timestamp,
  -- The provider's own next-page request: {"method":"GET","path":"..."}.
  "cursor" jsonb,

  "crm_import_id" text,
  "workflow_run_id" text,

  "last_run_at" timestamp,
  "last_error" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_connector_records" (
  "crm_connector_record_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "crm_connector_sync_id" text NOT NULL,

  "source_id" text NOT NULL,
  "source_modified_at" timestamp,
  -- Keyed by the header the provider's own CSV export writes, so these go
  -- through exactly the preview a pasted file goes through.
  "values" jsonb NOT NULL,

  "staged_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Split in two, per the lock rule: ADD CONSTRAINT ... FOREIGN KEY takes ACCESS
-- EXCLUSIVE on both tables while it installs triggers, so one long read of
-- `organizations` would stall every write to it.
ALTER TABLE "crm_connector_syncs"
  ADD CONSTRAINT "fk_crm_connector_syncs_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "crm_connector_records"
  ADD CONSTRAINT "fk_crm_connector_records_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "crm_connector_syncs" VALIDATE CONSTRAINT "fk_crm_connector_syncs_org";

--> statement-breakpoint
ALTER TABLE "crm_connector_records" VALIDATE CONSTRAINT "fk_crm_connector_records_org";

--> statement-breakpoint
-- Two watermarks for one stream would race, each reading the other's progress
-- as a gap, and neither would ever drain.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_connector_syncs_stream"
  ON "crm_connector_syncs" ("organization_id", "connection_id", "stream");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_connector_syncs_due"
  ON "crm_connector_syncs" ("organization_id", "last_run_at")
  WHERE "enabled" = true;

--> statement-breakpoint
-- The tenant-composite key every other table here carries, so a later composite
-- FK has something to point at.
ALTER TABLE "crm_connector_syncs"
  ADD CONSTRAINT "uniq_crm_connector_syncs_org_id"
  UNIQUE ("organization_id", "crm_connector_sync_id");

--> statement-breakpoint
-- The claim that makes a re-read of a page a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_connector_records_source"
  ON "crm_connector_records" ("organization_id", "crm_connector_sync_id", "source_id");

--> statement-breakpoint
-- The read the plan step makes: one walk's records, in the order they landed.
CREATE INDEX IF NOT EXISTS "idx_crm_connector_records_sync"
  ON "crm_connector_records" ("organization_id", "crm_connector_sync_id", "staged_at");

--> statement-breakpoint
-- A stream is one of four, and a provider one of four. A CHECK rather than an
-- enum: these two vocabularies belong to `connector-source.ts`, and a Postgres
-- enum would make adding a fifth provider a migration with a table rewrite
-- behind it.
ALTER TABLE "crm_connector_syncs"
  ADD CONSTRAINT "chk_crm_connector_syncs_provider"
  CHECK ("provider" IN ('salesforce', 'hubspot', 'zoho', 'pipedrive'));

--> statement-breakpoint
ALTER TABLE "crm_connector_syncs"
  ADD CONSTRAINT "chk_crm_connector_syncs_stream"
  CHECK ("stream" IN ('accounts', 'contacts', 'deals', 'activities'));

--> statement-breakpoint
ALTER TABLE "crm_connector_syncs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_connector_syncs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_connector_syncs"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_connector_syncs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_connector_syncs" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_connector_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_connector_records";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_connector_records"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_connector_records" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_connector_records" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_connector_syncs";
--> statement-breakpoint
ANALYZE "crm_connector_records";
