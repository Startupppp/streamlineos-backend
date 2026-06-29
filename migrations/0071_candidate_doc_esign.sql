-- Add e-sign tracking columns to candidate_documents
ALTER TABLE "candidate_documents"
  ADD COLUMN IF NOT EXISTS "external_doc_id" TEXT,
  ADD COLUMN IF NOT EXISTS "declined_at" TIMESTAMP;

CREATE INDEX IF NOT EXISTS "idx_candidate_docs_external"
  ON "candidate_documents" ("external_doc_id");
