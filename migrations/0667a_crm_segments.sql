-- Custom SQL migration file, put your code below! --

-- Named sets of CRM parties, defined by criteria and evaluated on read.
--
-- CRM-P2-01. Three decisions belong in the schema rather than only in the
-- service, because each of them is a thing a later writer could otherwise undo
-- without noticing.
--
-- There is no membership table, and there is not going to be one. A segment
-- stores what makes a row a member, not which rows are members: a materialised
-- membership is a copy of an answer and is stale from the moment the next party
-- is created, edited, reassigned or soft-deleted. The absence of a
-- `crm_segment_members` table and of a `last_evaluated_at` column is the design,
-- not an unfinished part of it -- a timestamp saying when the set was last
-- refreshed is exactly the field somebody reads as "current".
--
-- `criteria` is NOT NULL. A segment with no criteria is the whole source, which
-- is the parties list and already has a screen. Allowing an empty tree would
-- make "everyone" storable under a name that says otherwise.
--
-- `source_key` is not constrained to a value list here. What may be segmented is
-- the reporting compiler's registry (`src/modules/reporting/compiler/registry.ts`),
-- which is a reviewed allow-list in code; a CHECK repeating it would be a second
-- authority that needs a migration every time a source becomes segmentable, and
-- the two would disagree the first time one moved.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_segments" (
  "segment_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- Which registry source this reads. Stored rather than assumed even though
  -- one source is segmentable today, so the second one is a row's worth of data
  -- rather than a rewrite of every tenant's segments.
  "source_key" text NOT NULL,
  -- A `FilterNode` from the reporting compiler's vocabulary: named fields,
  -- enumerated operators, bound values. Inert until `compileQuery` turns it into
  -- parameterised SQL at read time, which is why storing it as jsonb is not an
  -- execution surface -- nothing in here ever reaches a statement as text.
  "criteria" jsonb NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- NOT VALID then VALIDATE, because ADD CONSTRAINT ... FOREIGN KEY takes ACCESS
-- EXCLUSIVE on BOTH tables while it installs its triggers.
ALTER TABLE "crm_segments"
  ADD CONSTRAINT "fk_crm_segments_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_segments" VALIDATE CONSTRAINT "fk_crm_segments_org";

--> statement-breakpoint
-- One segment per name per tenant. A segment's name is how it is referred to in
-- a campaign brief and a standup, so two segments called "Lapsed enterprise"
-- that return different sets is how a disagreement becomes unresolvable.
-- Composite on the tenant, or one organisation's "Customers" would block the
-- name for every other one -- a cross-tenant denial of service and a leak of
-- which names are taken.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_segments_org_name"
  ON "crm_segments" ("organization_id", "name");

--> statement-breakpoint
-- The list screen: this tenant's segments, most recently touched first.
CREATE INDEX IF NOT EXISTS "idx_crm_segments_org_updated"
  ON "crm_segments" ("organization_id", "updated_at");

--> statement-breakpoint
-- "What still reads this source", asked when a source is withdrawn from the
-- registry or the permission governing it is revoked.
CREATE INDEX IF NOT EXISTS "idx_crm_segments_org_source"
  ON "crm_segments" ("organization_id", "source_key");

--> statement-breakpoint
-- A segment names the criteria a tenant considers worth addressing as a group,
-- which is commercially sensitive on its own even before it is evaluated. A
-- missing policy here would be silent, because grants arrive through
-- ALTER DEFAULT PRIVILEGES.
ALTER TABLE "crm_segments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_segments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_segments"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_segments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_segments" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_segments";
