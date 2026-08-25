-- Custom SQL migration file, put your code below! --

-- Bringing a competitor's export in, and being able to take it back out again.
--
-- Two tables, and the split is what makes two of the ticket's criteria true at
-- once rather than by inspection.
--
-- `crm_import_rows` holds the PLAN: one row per line of the file, with the
-- action already decided. The preview is a reading of these rows and the commit
-- is an execution of the same rows, so "the committed result matches the
-- preview" is structural rather than a promise two code paths make separately.
--
-- Each row also records what it actually did — `created_party_id` for a create,
-- and `previous` for an update. That is what makes the whole import reversible
-- "restoring the prior state exactly": without the before-image an undo can
-- delete what it created but cannot put back what it overwrote, which is the
-- half people actually care about.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_imports" (
  "crm_import_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "status" text DEFAULT 'previewing' NOT NULL,
  "source_filename" text,
  -- The confirmed mapping, so a re-read of the preview cannot re-infer it
  -- differently after somebody answered an ambiguous column.
  "columns" jsonb,
  "summary" jsonb,
  "workflow_run_id" text,
  -- No FK to users: see 0223. Losing the record of who imported ten thousand
  -- rows because they later left is exactly the wrong trade.
  "created_by_user_id" text,
  "committed_at" timestamp,
  "reverted_at" timestamp,
  "reverted_by_user_id" text,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_status"
  CHECK ("status" IN ('previewing', 'committing', 'committed', 'reverted', 'failed'));

--> statement-breakpoint
-- Reverted implies committed: there is nothing to take back otherwise.
ALTER TABLE "crm_imports" ADD CONSTRAINT "chk_crm_imports_revert_after_commit"
  CHECK ("reverted_at" IS NULL OR "committed_at" IS NOT NULL);

--> statement-breakpoint
ALTER TABLE "crm_imports" ADD CONSTRAINT "fk_crm_imports_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_imports" VALIDATE CONSTRAINT "fk_crm_imports_org";

--> statement-breakpoint
-- The composite tenant key the rows point at.
ALTER TABLE "crm_imports" ADD CONSTRAINT "uniq_crm_imports_org_id"
  UNIQUE ("organization_id", "crm_import_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_imports_org_created"
  ON "crm_imports" ("organization_id", "created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_import_rows" (
  "crm_import_row_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "crm_import_id" text NOT NULL,
  -- 1-based, matching what the user sees in their spreadsheet.
  "row_number" integer NOT NULL,
  "action" text NOT NULL,
  "reason" text,
  "values" jsonb,
  "custom_fields" jsonb,
  "matched_party_id" text,
  "duplicate_of_row" integer,
  -- What it actually did, filled in at commit. Both are needed to undo it: one
  -- says what to delete, the other what to put back.
  "created_party_id" text,
  "previous" jsonb,
  "committed_at" timestamp,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_action"
  CHECK ("action" IN ('create', 'update', 'skip'));

--> statement-breakpoint
-- A created row records what it created; an updated row records what it
-- replaced. Neither can be reversed without its half.
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "chk_crm_import_rows_outcome"
  CHECK (
    "committed_at" IS NULL
    OR "action" = 'skip'
    OR ("action" = 'create' AND "created_party_id" IS NOT NULL)
    OR ("action" = 'update' AND "previous" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "fk_crm_import_rows_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" VALIDATE CONSTRAINT "fk_crm_import_rows_org";

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ADD CONSTRAINT "fk_crm_import_rows_import"
  FOREIGN KEY ("organization_id", "crm_import_id")
  REFERENCES "crm_imports"("organization_id", "crm_import_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_import_rows" VALIDATE CONSTRAINT "fk_crm_import_rows_import";

--> statement-breakpoint
-- One plan row per line of the file. A retry that re-planned would otherwise
-- double every row and the preview would stop matching the commit.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_import_rows_line"
  ON "crm_import_rows" ("organization_id", "crm_import_id", "row_number");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_import_rows_import"
  ON "crm_import_rows" ("organization_id", "crm_import_id", "row_number");

--> statement-breakpoint
-- What a reversal has to undo: everything this import committed.
CREATE INDEX IF NOT EXISTS "idx_crm_import_rows_committed"
  ON "crm_import_rows" ("organization_id", "crm_import_id")
  WHERE "committed_at" IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "crm_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_imports";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_imports"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_imports" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_imports" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_import_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_import_rows";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_import_rows"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_import_rows" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_import_rows" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_imports";
--> statement-breakpoint
ANALYZE "crm_import_rows";
