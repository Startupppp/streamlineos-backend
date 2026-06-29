CREATE TABLE IF NOT EXISTS "document_template_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "template_id" integer NOT NULL REFERENCES "document_templates"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "type" text NOT NULL,
  "html_content" text NOT NULL,
  "variables" jsonb DEFAULT '[]' NOT NULL,
  "archived_at" timestamp DEFAULT now(),
  "archived_by" text NOT NULL REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "idx_dtv_template_id" ON "document_template_versions" ("template_id");
