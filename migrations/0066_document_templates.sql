CREATE TABLE IF NOT EXISTS "document_templates" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "title" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'OFFER',
  "html_content" TEXT NOT NULL DEFAULT '',
  "variables" JSONB NOT NULL DEFAULT '[]',
  "version" INTEGER NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_doc_templates_org" ON "document_templates"("org_id", "type");

CREATE TABLE IF NOT EXISTS "candidate_documents" (
  "id" SERIAL PRIMARY KEY,
  "candidate_id" INTEGER NOT NULL,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "template_id" INTEGER REFERENCES "document_templates"("id"),
  "title" TEXT NOT NULL,
  "html_content" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'GENERATED',
  "sent_at" TIMESTAMP,
  "viewed_at" TIMESTAMP,
  "signed_at" TIMESTAMP,
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_candidate_docs_candidate" ON "candidate_documents"("candidate_id");
