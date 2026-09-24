-- 1198 — HR documents: who a document is for, and its file history (HRMS-KB PR 2)
--
-- Two small tables that sit beside `documents`.
--
-- `document_audiences` is the CEILING on who may be shown a document: all employees, one department, or
-- one location. No rows means HR-only, which is the fail-closed reading. A knowledge-base link (1199)
-- carries its own audience and must stay inside this one; the application enforces the subset, and the
-- read path repeats the check so a narrowed ceiling takes effect on the next request.
--
-- `document_versions` is the file history. `documents.version` has been 1 on every row since the column
-- was added and `parent_document_id` has never been written, so there is no version model to extend.
-- `documents` keeps holding the CURRENT APPROVED file, which is why `GET /hr/documents/:id/file` and every
-- other reader are untouched: approving a version copies its file onto the `documents` row. This table
-- holds the history, the pending upload, and what a pinned knowledge-base link resolves against.
--
-- NOT named `hr_*`, but check:hr-table-freeze counts by schema directory, not by name, so both tables are
-- recorded in its APPROVED_EXCEPTIONS with the reasons below. Neither fits "an existing lifecycle column
-- or a custom field": an audience is a SET of (kind, ref) pairs per document and a version history is many
-- rows per document, and each needs the composite tenant FKs and the uniqueness above.
--
-- `ref_id` is text because department and location ids are text (`hr_employments.department_id`,
-- `location_id`). It has no foreign key: the two kinds point at different tables, and a deleted
-- department leaves an audience row nobody can match, which is the safe direction.
--
-- Rollback: migrations/rollback/1198_document_audiences_and_versions.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."document_audiences" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "document_id" integer NOT NULL,
  "kind" text NOT NULL,
  "ref_id" text,
  "created_by_membership_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_document_audiences_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_document_audiences_kind" CHECK ("kind" IN ('ALL_EMPLOYEES', 'DEPARTMENT', 'LOCATION')),
  -- ALL_EMPLOYEES names nobody; the other two must name one.
  CONSTRAINT "chk_document_audiences_ref" CHECK (("kind" = 'ALL_EMPLOYEES') = ("ref_id" IS NULL))
);
--> statement-breakpoint

-- The same audience twice on one document is a duplicate, whatever spelling of "no ref" it arrives in.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_audiences_member"
  ON "public"."document_audiences" ("org_id", "document_id", "kind", (coalesce("ref_id", '')));
--> statement-breakpoint

-- The audience predicate asks "which documents are for department X / location Y" for one tenant.
CREATE INDEX IF NOT EXISTS "idx_document_audiences_org_kind_ref"
  ON "public"."document_audiences" ("org_id", "kind", "ref_id");
--> statement-breakpoint

-- FK-supporting index, not partial: the parent-side delete of a membership has to find every child.
CREATE INDEX IF NOT EXISTS "idx_document_audiences_org_created_by_membership"
  ON "public"."document_audiences" ("org_id", "created_by_membership_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."document_versions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "document_id" integer NOT NULL,
  "version" integer NOT NULL,
  "file_url" text NOT NULL,
  "file_name" text,
  "file_size" integer,
  "mime_type" text,
  "status" text NOT NULL DEFAULT 'pending',
  "effective_date" date,
  "uploaded_by_membership_id" integer,
  "approved_by_membership_id" integer,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_document_versions_org_id" UNIQUE ("org_id", "id"),
  -- One row per version number per document; also the index the "latest approved" lookup scans backwards.
  CONSTRAINT "uniq_document_versions_doc_version" UNIQUE ("org_id", "document_id", "version"),
  CONSTRAINT "chk_document_versions_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "chk_document_versions_status" CHECK ("status" IN ('pending', 'approved', 'rejected')),
  CONSTRAINT "chk_document_versions_approved_stamped" CHECK ("status" <> 'approved' OR "approved_at" IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_document_versions_org_uploaded_by_membership"
  ON "public"."document_versions" ("org_id", "uploaded_by_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_versions_org_approved_by_membership"
  ON "public"."document_versions" ("org_id", "approved_by_membership_id");
--> statement-breakpoint

-- Foreign keys: NOT VALID then VALIDATE, so the install does not hold ACCESS EXCLUSIVE on `documents` and
-- `organization_members` (read by every request) while it builds the triggers. Both tables are new and
-- empty, so VALIDATE is instant; the two-step form is kept because the rule is about the habit.
ALTER TABLE "public"."document_audiences" DROP CONSTRAINT IF EXISTS "document_audiences_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."document_audiences" ADD CONSTRAINT "document_audiences_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_audiences" VALIDATE CONSTRAINT "document_audiences_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."document_audiences" DROP CONSTRAINT IF EXISTS "fk_document_audiences_document_id_org";
--> statement-breakpoint
-- CASCADE: an audience row means nothing without its document.
ALTER TABLE "public"."document_audiences" ADD CONSTRAINT "fk_document_audiences_document_id_org"
  FOREIGN KEY ("org_id", "document_id") REFERENCES "public"."documents" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_audiences" VALIDATE CONSTRAINT "fk_document_audiences_document_id_org";
--> statement-breakpoint

ALTER TABLE "public"."document_audiences" DROP CONSTRAINT IF EXISTS "fk_document_audiences_created_by_actor";
--> statement-breakpoint
-- The column list on SET NULL is load-bearing: a bare SET NULL on a composite key nulls org_id too.
ALTER TABLE "public"."document_audiences" ADD CONSTRAINT "fk_document_audiences_created_by_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_audiences" VALIDATE CONSTRAINT "fk_document_audiences_created_by_actor";
--> statement-breakpoint

ALTER TABLE "public"."document_versions" DROP CONSTRAINT IF EXISTS "document_versions_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "document_versions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_versions" VALIDATE CONSTRAINT "document_versions_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."document_versions" DROP CONSTRAINT IF EXISTS "fk_document_versions_document_id_org";
--> statement-breakpoint
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "fk_document_versions_document_id_org"
  FOREIGN KEY ("org_id", "document_id") REFERENCES "public"."documents" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_versions" VALIDATE CONSTRAINT "fk_document_versions_document_id_org";
--> statement-breakpoint

ALTER TABLE "public"."document_versions" DROP CONSTRAINT IF EXISTS "fk_document_versions_uploaded_by_actor";
--> statement-breakpoint
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "fk_document_versions_uploaded_by_actor"
  FOREIGN KEY ("org_id", "uploaded_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("uploaded_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_versions" VALIDATE CONSTRAINT "fk_document_versions_uploaded_by_actor";
--> statement-breakpoint

ALTER TABLE "public"."document_versions" DROP CONSTRAINT IF EXISTS "fk_document_versions_approved_by_actor";
--> statement-breakpoint
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "fk_document_versions_approved_by_actor"
  FOREIGN KEY ("org_id", "approved_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("approved_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."document_versions" VALIDATE CONSTRAINT "fk_document_versions_approved_by_actor";
--> statement-breakpoint

ALTER TABLE "public"."document_audiences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."document_audiences";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."document_audiences"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "public"."document_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."document_versions";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."document_versions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."document_audiences" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "public"."document_audiences_id_seq" TO streamline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."document_versions" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "public"."document_versions_id_seq" TO streamline_app;
