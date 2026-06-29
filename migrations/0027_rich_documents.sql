CREATE TABLE IF NOT EXISTS "rich_documents" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "content_json" jsonb,
  "template_type" text,
  "is_published" boolean DEFAULT false,
  "version" integer DEFAULT 1,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "updated_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_rich_documents_org" ON "rich_documents" ("org_id");
