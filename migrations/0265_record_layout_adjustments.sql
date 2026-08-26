-- Custom SQL migration file, put your code below! --

-- A tenant's arrangement of a record type.
--
-- Phase 2 ticket 20. The client for this was built, wired and tested against a
-- contract, and none of it did anything for a tenant because the four endpoints
-- did not exist. This is the storage half.
--
-- Only presentation lives here. `order` and `hidden` name fields the layout
-- description already publishes, and `groups` re-sections them. A hidden field
-- is not a protected one -- anything treating it as such would be building
-- authorisation out of a display preference.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_layout_adjustments" (
  "record_layout_adjustment_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "layout_key" text NOT NULL,
  "order" jsonb,
  "hidden" jsonb,
  "groups" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- NOT VALID then VALIDATE, so installing the trigger does not hold ACCESS
-- EXCLUSIVE on organizations while it runs.
ALTER TABLE "record_layout_adjustments" ADD CONSTRAINT "fk_record_layout_adjustments_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "record_layout_adjustments" VALIDATE CONSTRAINT "fk_record_layout_adjustments_org";

--> statement-breakpoint
-- One arrangement per type per tenant. A second row would make the rendered
-- layout depend on which the query happened to read first, and the upsert in
-- the service targets exactly this pair.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_record_layout_adjustments_org_key"
  ON "record_layout_adjustments" ("organization_id", "layout_key");

--> statement-breakpoint
-- Every record surface in the product reads this on load, so the read is what
-- matters: organisation first, then what the caller projects.
CREATE INDEX IF NOT EXISTS "idx_record_layout_adjustments_org"
  ON "record_layout_adjustments" ("organization_id", "updated_at");

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent.
ALTER TABLE "record_layout_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "record_layout_adjustments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "record_layout_adjustments"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "record_layout_adjustments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "record_layout_adjustments" TO streamline_app;

--> statement-breakpoint
ANALYZE "record_layout_adjustments";
