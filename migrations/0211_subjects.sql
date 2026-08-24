-- Custom SQL migration file, put your code below! --

-- The thing a tenant transacts: a declared subject type, its records, and the
-- link table joining them to parties.
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_types" (
  "subject_type_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "key" text NOT NULL,
  "singular" text NOT NULL,
  "plural" text NOT NULL,
  "title_field" text NOT NULL,
  "fields" jsonb NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subjects" (
  "subject_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "subject_type_id" text NOT NULL,
  "title" text NOT NULL,
  "reference" text,
  "status" text,
  "custom_fields" jsonb,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_party_links" (
  "subject_party_link_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "party_id" text NOT NULL,
  "relationship" text NOT NULL,
  "linked_at" timestamp DEFAULT now() NOT NULL,
  "linked_by" text
);

--> statement-breakpoint
-- The tenant keys the composite foreign keys below point at. A plain
-- (subject_id) target would let a link cross organisations while still
-- satisfying referential integrity; carrying organization_id in the key makes
-- that unrepresentable rather than merely tested for.
ALTER TABLE "subject_types" ADD CONSTRAINT "uniq_subject_types_org_id"
  UNIQUE ("organization_id", "subject_type_id");
--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "uniq_subjects_org_id"
  UNIQUE ("organization_id", "subject_id");

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding each key does not hold ACCESS EXCLUSIVE on
-- the referenced table while it installs triggers.
ALTER TABLE "subject_types" ADD CONSTRAINT "fk_subject_types_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subject_types" VALIDATE CONSTRAINT "fk_subject_types_org";
--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "fk_subjects_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subjects" VALIDATE CONSTRAINT "fk_subjects_org";
--> statement-breakpoint
ALTER TABLE "subject_party_links" ADD CONSTRAINT "fk_subject_party_links_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subject_party_links" VALIDATE CONSTRAINT "fk_subject_party_links_org";

--> statement-breakpoint
-- A subject belongs to a declared type in its own organisation, and a link
-- joins a subject and a party that both live in the linking organisation.
ALTER TABLE "subjects" ADD CONSTRAINT "fk_subjects_type"
  FOREIGN KEY ("organization_id", "subject_type_id")
  REFERENCES "subject_types"("organization_id", "subject_type_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subjects" VALIDATE CONSTRAINT "fk_subjects_type";
--> statement-breakpoint
ALTER TABLE "subject_party_links" ADD CONSTRAINT "fk_subject_party_links_subject"
  FOREIGN KEY ("organization_id", "subject_id")
  REFERENCES "subjects"("organization_id", "subject_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subject_party_links" VALIDATE CONSTRAINT "fk_subject_party_links_subject";
--> statement-breakpoint
ALTER TABLE "subject_party_links" ADD CONSTRAINT "fk_subject_party_links_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "subject_party_links" VALIDATE CONSTRAINT "fk_subject_party_links_party";

--> statement-breakpoint
-- Tenant-scoped, not global: two organisations may both call a type "property".
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subject_types_org_key"
  ON "subject_types" ("organization_id", "key") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subject_types_org"
  ON "subject_types" ("organization_id", "created_at");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subjects_org_type_reference"
  ON "subjects" ("organization_id", "subject_type_id", "reference")
  WHERE "reference" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
-- The list read: one type, newest first. Leading organization_id because the
-- policy predicate is not leakproof and the planner needs it in the index.
CREATE INDEX IF NOT EXISTS "idx_subjects_org_type_created"
  ON "subjects" ("organization_id", "subject_type_id", "created_at", "subject_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subjects_org_title"
  ON "subjects" ("organization_id", "title") WHERE "deleted_at" IS NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subject_party_link"
  ON "subject_party_links" ("organization_id", "subject_id", "party_id", "relationship");
--> statement-breakpoint
-- Both directions are read: a subject's parties, and a party's subjects.
CREATE INDEX IF NOT EXISTS "idx_subject_party_links_by_party"
  ON "subject_party_links" ("organization_id", "party_id", "subject_id");

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide, because grants
-- arrive through ALTER DEFAULT PRIVILEGES and a missing policy is silent.
ALTER TABLE "subject_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "subject_types";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subject_types"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "subject_types" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_types" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "subjects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "subjects";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subjects"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "subjects" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subjects" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "subject_party_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "subject_party_links";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subject_party_links"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "subject_party_links" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_party_links" TO streamline_app;

--> statement-breakpoint
-- Stats and the visibility map decide whether the new partial indexes are usable
-- at all; without this an index-only scan is refused regardless of the index.
ANALYZE "subject_types";
--> statement-breakpoint
ANALYZE "subjects";
--> statement-breakpoint
ANALYZE "subject_party_links";
