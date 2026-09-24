-- 1199 — Knowledge base: linked HR documents, their guard, and the per-tenant switches (HRMS-KB PR 2)
--
-- A linked document is a pointer from the knowledge base to one HR document. It is NOT a `kb_pages` row.
-- That is deliberate and is the reason this table exists: the KB has several readers that bypass the
-- canonical page predicate (the legacy chunk predicate, the HR helpdesk suggest query, Ask's raw
-- `content_text` fallback), an owner / `kb:spaces:manage` short-circuit, and an `external_source`
-- namespace any importer can forge. A marker on `kb_pages` would make every one of those readers
-- responsible for excluding an HR document. Here they are blind to it by construction, and the only
-- readers are the new ones, which repeat the source document's state in the same SQL statement.
--
-- Nothing here is populated by this migration and nothing reads it yet: the tables are empty, the three
-- switches default to false, and every route that would use them answers 404 while they are off.
--
-- The guard that keeps a personal document from ever being linked is the NEXT migration (1200), kept
-- separate so this one is only DDL and one purpose does not hide inside another.
--
-- The switches live on `kb_settings`, the existing one-row-per-organisation settings table, as three
-- booleans that default to false. `search` requires `link` and `ai` requires `search`, enforced by a check.
--
-- Rollback: migrations/rollback/1199_kb_linked_documents.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_linked_documents" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  -- Nullable so a hard delete of the document can clear the pointer (SET NULL) instead of blocking it.
  "document_id" integer,
  "version_mode" text NOT NULL DEFAULT 'FOLLOW_LATEST',
  "pinned_version" integer,
  "status" text NOT NULL DEFAULT 'active',
  -- Browse grouping only. It never grants access: audience does.
  "space_id" integer,
  "published_by_membership_id" integer,
  "published_at" timestamp with time zone NOT NULL DEFAULT now(),
  "unpublished_by_membership_id" integer,
  "unpublished_at" timestamp with time zone,
  "unpublish_reason" text,
  "source_removed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_linked_documents_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_kb_linked_documents_version_mode" CHECK ("version_mode" IN ('FOLLOW_LATEST', 'PINNED')),
  CONSTRAINT "chk_kb_linked_documents_pin" CHECK (("version_mode" = 'PINNED') = ("pinned_version" IS NOT NULL)),
  CONSTRAINT "chk_kb_linked_documents_pin_positive" CHECK ("pinned_version" IS NULL OR "pinned_version" >= 1),
  CONSTRAINT "chk_kb_linked_documents_status" CHECK ("status" IN ('active', 'unpublished', 'source_removed')),
  CONSTRAINT "chk_kb_linked_documents_unpublished_stamped" CHECK ("status" = 'active' OR "unpublished_at" IS NOT NULL),
  CONSTRAINT "chk_kb_linked_documents_removed_stamped" CHECK ("status" <> 'source_removed' OR "source_removed_at" IS NOT NULL)
);
--> statement-breakpoint

-- One live link per document. Partial: an unpublished link is history and a document can be re-published.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_linked_documents_active_document"
  ON "public"."kb_linked_documents" ("org_id", "document_id")
  WHERE "status" = 'active' AND "document_id" IS NOT NULL;
--> statement-breakpoint

-- The reader's list: one tenant's active entries, newest first, keyset-paginated on (published_at, id).
CREATE INDEX IF NOT EXISTS "idx_kb_linked_documents_org_status_published"
  ON "public"."kb_linked_documents" ("org_id", "status", "published_at" DESC, "id" DESC);
--> statement-breakpoint

-- FK-supporting indexes, NOT partial: the parent-side delete must find every child, unpublished ones too.
CREATE INDEX IF NOT EXISTS "idx_kb_linked_documents_org_document"
  ON "public"."kb_linked_documents" ("org_id", "document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_linked_documents_org_space"
  ON "public"."kb_linked_documents" ("org_id", "space_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_linked_documents_org_published_by"
  ON "public"."kb_linked_documents" ("org_id", "published_by_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_linked_documents_org_unpublished_by"
  ON "public"."kb_linked_documents" ("org_id", "unpublished_by_membership_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_linked_document_audiences" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "linked_document_id" integer NOT NULL,
  "kind" text NOT NULL,
  "ref_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_linked_document_audiences_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_kb_linked_document_audiences_kind" CHECK ("kind" IN ('ALL_EMPLOYEES', 'DEPARTMENT', 'LOCATION')),
  CONSTRAINT "chk_kb_linked_document_audiences_ref" CHECK (("kind" = 'ALL_EMPLOYEES') = ("ref_id" IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_linked_document_audiences_member"
  ON "public"."kb_linked_document_audiences" ("org_id", "linked_document_id", "kind", (coalesce("ref_id", '')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_linked_document_audiences_org_kind_ref"
  ON "public"."kb_linked_document_audiences" ("org_id", "kind", "ref_id");
--> statement-breakpoint

-- Foreign keys, NOT VALID then VALIDATE (see 1198).
ALTER TABLE "public"."kb_linked_documents" DROP CONSTRAINT IF EXISTS "kb_linked_documents_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" ADD CONSTRAINT "kb_linked_documents_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" VALIDATE CONSTRAINT "kb_linked_documents_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_documents" DROP CONSTRAINT IF EXISTS "fk_kb_linked_documents_document_id_org";
--> statement-breakpoint
-- SET NULL (document_id), never a bare SET NULL: on a composite key that nulls org_id too and aborts the delete.
ALTER TABLE "public"."kb_linked_documents" ADD CONSTRAINT "fk_kb_linked_documents_document_id_org"
  FOREIGN KEY ("org_id", "document_id") REFERENCES "public"."documents" ("org_id", "id")
  ON DELETE SET NULL ("document_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" VALIDATE CONSTRAINT "fk_kb_linked_documents_document_id_org";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_documents" DROP CONSTRAINT IF EXISTS "fk_kb_linked_documents_space_id_org";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" ADD CONSTRAINT "fk_kb_linked_documents_space_id_org"
  FOREIGN KEY ("org_id", "space_id") REFERENCES "public"."kb_spaces" ("org_id", "id")
  ON DELETE SET NULL ("space_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" VALIDATE CONSTRAINT "fk_kb_linked_documents_space_id_org";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_documents" DROP CONSTRAINT IF EXISTS "fk_kb_linked_documents_published_by_actor";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" ADD CONSTRAINT "fk_kb_linked_documents_published_by_actor"
  FOREIGN KEY ("org_id", "published_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("published_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" VALIDATE CONSTRAINT "fk_kb_linked_documents_published_by_actor";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_documents" DROP CONSTRAINT IF EXISTS "fk_kb_linked_documents_unpublished_by_actor";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" ADD CONSTRAINT "fk_kb_linked_documents_unpublished_by_actor"
  FOREIGN KEY ("org_id", "unpublished_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("unpublished_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_documents" VALIDATE CONSTRAINT "fk_kb_linked_documents_unpublished_by_actor";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_document_audiences" DROP CONSTRAINT IF EXISTS "kb_linked_document_audiences_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_document_audiences" ADD CONSTRAINT "kb_linked_document_audiences_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_document_audiences" VALIDATE CONSTRAINT "kb_linked_document_audiences_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_document_audiences" DROP CONSTRAINT IF EXISTS "fk_kb_linked_document_audiences_link_org";
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_document_audiences" ADD CONSTRAINT "fk_kb_linked_document_audiences_link_org"
  FOREIGN KEY ("org_id", "linked_document_id") REFERENCES "public"."kb_linked_documents" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_document_audiences" VALIDATE CONSTRAINT "fk_kb_linked_document_audiences_link_org";
--> statement-breakpoint

ALTER TABLE "public"."kb_linked_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_linked_documents";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."kb_linked_documents"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
ALTER TABLE "public"."kb_linked_document_audiences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_linked_document_audiences";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."kb_linked_document_audiences"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."kb_linked_documents" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "public"."kb_linked_documents_id_seq" TO streamline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."kb_linked_document_audiences" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "public"."kb_linked_document_audiences_id_seq" TO streamline_app;
--> statement-breakpoint

-- The three per-tenant switches. Default false, and the order is a constraint, not a convention.
ALTER TABLE "public"."kb_settings" ADD COLUMN IF NOT EXISTS "hrms_kb_link_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" ADD COLUMN IF NOT EXISTS "hrms_kb_search_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" ADD COLUMN IF NOT EXISTS "hrms_kb_ai_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" DROP CONSTRAINT IF EXISTS "chk_kb_settings_hrms_flag_order";
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" ADD CONSTRAINT "chk_kb_settings_hrms_flag_order"
  CHECK ((NOT "hrms_kb_search_enabled" OR "hrms_kb_link_enabled") AND (NOT "hrms_kb_ai_enabled" OR "hrms_kb_search_enabled")) NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" VALIDATE CONSTRAINT "chk_kb_settings_hrms_flag_order";
--> statement-breakpoint
