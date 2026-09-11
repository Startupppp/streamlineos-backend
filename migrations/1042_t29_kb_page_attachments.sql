-- 1042: give KB page media a row, so it has an org to belong to.
--
-- KbMediaService.upload wrote to object storage and returned a key with ZERO
-- database writes. Nothing recorded who uploaded the file, which organisation it
-- belonged to or which page referenced it: the only tenancy the object carried
-- was the `kb-media/<org_id>/` prefix in its own key, which is a naming
-- convention, not a constraint. Ticket 29's Knowledge box asks that attachments
-- "carry tenant-composite integrity"; there was no row to give integrity to.
--
-- This is the wiki twin of kb_article_attachments (schema/support/kb-attachments.ts),
-- and it is deliberately shaped the same way:
--
--   * uniq_kb_page_attachments_org_id -- the (org_id, id) tenant anchor every
--     other kb table carries, so a future child can take a composite FK.
--   * fk_kb_page_attachments_org_page -- (org_id, page_id) -> kb_pages(org_id, id).
--     COMPOSITE, not a bare page_id: a single-column FK would let a row in org A
--     name a page in org B and still satisfy the constraint.
--   * page_id is NULLABLE on purpose. /kb/media accepts an upload with no page
--     (a cover image chosen before the page is saved), and a composite FK with a
--     NULL member is not enforced under MATCH SIMPLE, which is the intended
--     "not attached to a page" state -- not a hole.
--   * uniq_kb_page_attachments_org_file_key -- the storage key IS the object's
--     identity. The upload path is at-least-once from the caller's point of view
--     (a retried multipart POST re-uploads the bytes), and without this a retry
--     mints a second row for one object. Scoped to the org rather than global so
--     one tenant's key value can never block another's (BE/CLAUDE.md section 3).
--   * deleted_at + the partial index -- soft delete is the default for a business
--     entity, and every read filters it.
--
-- The FK is inline in CREATE TABLE rather than a later ADD CONSTRAINT: the table
-- is empty at creation, so there is no validation pass to take ACCESS EXCLUSIVE
-- on kb_pages for, and the NOT VALID/VALIDATE split has nothing to split.
--
-- ON DELETE CASCADE matches kb_article_attachments. kb_pages is soft-deleted in
-- the ordinary case, so this fires only on the two genuine hard deletes
-- (emptyTrash, purgeExpired). NOTE for whoever owns upload lifecycle (ticket 33):
-- the cascade removes the ledger row but NOT the R2 object. That object is
-- orphaned today as well -- there is no row at all -- so this is not a
-- regression, but with this table a purge sweep finally has something to read.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kb_page_attachments" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer,
  "file_key" text NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size" integer NOT NULL,
  "sha256" text,
  "uploaded_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "uniq_kb_page_attachments_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "kb_page_attachments_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade,
  CONSTRAINT "kb_page_attachments_uploaded_by_id_users_id_fk"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null,
  CONSTRAINT "fk_kb_page_attachments_org_page"
    FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages"("org_id", "id") ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_page_attachments_org_file_key"
  ON "kb_page_attachments" ("org_id", "file_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_page_attachments_org_page"
  ON "kb_page_attachments" ("org_id", "page_id", "created_at")
  WHERE "deleted_at" IS NULL;
