-- 1197 — HR documents: a classification that fails closed (HRMS-KB PR 2)
--
-- Nothing on `documents` says whether a file is about the company or about a person. `type` is the
-- closest signal and it is not enough: an HR-uploaded handbook is owned by the uploader, the CSV import
-- attaches company files to whoever an email resolves to, and `is_public` is a per-row flag that PR 1
-- had to stop honouring on personal types. Publishing anything to the knowledge base needs an explicit,
-- human, auditable statement of what a document is.
--
-- The default is the whole design. `PERSONAL` is what every existing row becomes and what every row
-- written by any writer that does not know about this column (import, onboarding upload, recruitment
-- handoff, the seed script) will get. Nothing is publishable until a person with `hr:documents:publish`
-- moves a document to INTERNAL or RESTRICTED. Adding the column with a constant default is a catalog
-- change in Postgres 11+, not a table rewrite, and no existing row's meaning changes: every read path
-- that exists today ignores it.
--
-- `effective_date` is the date a policy takes effect, shown on the knowledge-base badge. It is not
-- `expiry_date` (when the file stops being valid) and not `created_at`. Nullable: most documents have none.
--
-- No index. The only query that filters on classification is the publish picker, over one tenant's
-- handful of company documents; an index would be cost on every INSERT for no measured read.
--
-- Rollback: migrations/rollback/1197_document_classification.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'document_classification' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."document_classification" AS ENUM ('PERSONAL', 'CONFIDENTIAL', 'RESTRICTED', 'INTERNAL');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."documents"
  ADD COLUMN IF NOT EXISTS "classification" "public"."document_classification" NOT NULL DEFAULT 'PERSONAL';
--> statement-breakpoint

ALTER TABLE "public"."documents"
  ADD COLUMN IF NOT EXISTS "effective_date" date;
