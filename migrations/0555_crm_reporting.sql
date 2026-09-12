-- Custom SQL migration file, put your code below! --

-- Saved report definitions, and the log of what was compiled from them.
--
-- Phase 5 ticket 10. The module these back is a compiler: a tenant sends a
-- structured description drawn from a closed enumeration, and it becomes
-- parameterised SQL. A tenant never supplies SQL text, so injection is not
-- mitigated here -- it is unrepresentable.
--
-- Two decisions in this file follow from that and are worth stating in the
-- schema rather than only in the service.
--
-- `query_description` stores the DESCRIPTION, not generated SQL. A row here is
-- inert JSON until the compiler reads it, so writing to this table -- by any
-- route, including directly -- cannot produce execution. Had it stored SQL, an
-- UPDATE against it would have been a remote code path, and the table would have
-- needed to be treated as executable content forever after.
--
-- `compiled_sql` on the run log stores the statement that WAS executed, and can
-- be stored in the clear for one specific reason: a compiled statement contains
-- no literals, only `$n` placeholders. So the column holds the shape of a
-- question and none of its content -- no filter values, no customer names, no
-- thresholds. An auditor can read every row and learn what was asked without
-- learning anything about the data. Storing the bound parameters beside it would
-- undo that in a single column, which is why only `parameter_count` is kept.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_report_definitions" (
  "report_definition_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- Duplicated out of the jsonb below. "Which saved reports read parties?" is
  -- asked when a permission is withdrawn or a table retired, and answering it by
  -- parsing every blob makes it a scan with a JSON parse per row.
  "source_key" text NOT NULL,
  "query_description" jsonb NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
-- NOT VALID then VALIDATE, so adding the constraint does not hold ACCESS
-- EXCLUSIVE on organizations while it runs.
ALTER TABLE "crm_report_definitions" ADD CONSTRAINT "fk_crm_report_definitions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_report_definitions" VALIDATE CONSTRAINT "fk_crm_report_definitions_org";

--> statement-breakpoint
-- One report per name per tenant. Two reports called "Q3 pipeline" returning
-- different numbers is how a disagreement in a meeting becomes unresolvable, and
-- the service's write path targets exactly this pair.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_report_definitions_org_name"
  ON "crm_report_definitions" ("organization_id", "name");

--> statement-breakpoint
-- The list screen: this tenant's reports, most recently touched first.
CREATE INDEX IF NOT EXISTS "idx_crm_report_definitions_org"
  ON "crm_report_definitions" ("organization_id", "updated_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_report_definitions_org_source"
  ON "crm_report_definitions" ("organization_id", "source_key");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_report_runs" (
  "report_run_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- Null for an ad-hoc run, which is the kind an auditor most wants to see: a
  -- saved report was reviewed by whoever saved it, an ad-hoc query was not.
  --
  -- Deliberately NOT a foreign key to crm_report_definitions. The audit trail
  -- has to outlive the thing it audits: with ON DELETE CASCADE, deleting a
  -- report would erase the record that it was ever run, and with RESTRICT a
  -- report could never be deleted at all. A dangling id that no longer resolves
  -- is the correct outcome -- the run happened, and the definition is gone.
  "report_definition_id" text,
  "source_key" text NOT NULL,
  -- Contains no literals. See the header.
  "compiled_sql" text NOT NULL,
  "parameter_count" integer NOT NULL,
  "row_count" integer,
  "duration_ms" integer,
  "ran_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_report_runs" ADD CONSTRAINT "fk_crm_report_runs_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_report_runs" VALIDATE CONSTRAINT "fk_crm_report_runs_org";

--> statement-breakpoint
-- The audit read: this tenant's runs, newest first.
CREATE INDEX IF NOT EXISTS "idx_crm_report_runs_org_created"
  ON "crm_report_runs" ("organization_id", "created_at");

--> statement-breakpoint
-- "How often is this report run, and by whom."
CREATE INDEX IF NOT EXISTS "idx_crm_report_runs_org_definition"
  ON "crm_report_runs" ("organization_id", "report_definition_id");

--> statement-breakpoint
-- Without a policy these tables are readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent.
--
-- It matters more here than on most tables. A saved description names the fields
-- one tenant reports on, which is a description of how they run their business;
-- and while the run log holds no values, it does hold who ran what and when.
ALTER TABLE "crm_report_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_report_definitions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_report_definitions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_report_definitions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_report_definitions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_report_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_report_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_report_runs"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_report_runs" FROM PUBLIC;
--> statement-breakpoint
-- No DELETE. An audit trail a tenant can erase through the application is not an
-- audit trail, and nothing in the module deletes a run row; retention, when it
-- is decided, belongs to a maintenance job with its own role, not to this grant.
GRANT SELECT, INSERT ON "crm_report_runs" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_report_definitions";
--> statement-breakpoint
ANALYZE "crm_report_runs";
