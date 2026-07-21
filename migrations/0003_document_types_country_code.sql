ALTER TABLE "document_types" ADD COLUMN IF NOT EXISTS "country_code" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_doc_types_org_country" ON "document_types" ("org_id","country_code");
