-- Attachments on accounting documents (`09-feature-backlog.md` §N, v1).
--
-- A vendor's own PDF bill, a signed contract behind an invoice, the bank advice
-- behind a receipt. The bytes go to R2; this table is the pointer plus the
-- metadata a list screen needs, so listing never touches object storage.
--
-- Hand-authored rather than generated: `migrations/meta` snapshots stop at 0231
-- while migrations run to 0468, so `drizzle-kit generate` would propose
-- recreating ~230 applied migrations. Every object here matches
-- `db/schema/accounting/attachments.ts`.
--
-- The table is new, so the foreign keys and NOT NULLs are declared inline — the
-- ADD CONSTRAINT ... NOT VALID dance in backend/CLAUDE.md §3 exists for adding
-- constraints to populated tables, and there is nothing here to lock.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acct_document_attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "storage_url" text,
  "uploaded_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_acct_document_attachments_org_id" UNIQUE("org_id","id"),
  CONSTRAINT "uniq_acct_document_attachments_book_id" UNIQUE("book_id","id"),
  CONSTRAINT "ck_acct_document_attachments_type" CHECK (
    "document_type" IN (
      'sales_invoice','credit_note','purchase_bill','debit_note','receipt','payment','journal'
    )
  ),
  CONSTRAINT "ck_acct_document_attachments_size" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint
-- The list access path: everything still attached to one document.
CREATE INDEX IF NOT EXISTS "idx_acct_document_attachments_document"
  ON "acct_document_attachments" ("book_id","document_type","document_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_acct_document_attachments_org_book"
  ON "acct_document_attachments" ("org_id","book_id");
