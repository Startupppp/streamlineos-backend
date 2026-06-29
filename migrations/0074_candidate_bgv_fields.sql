-- Add background verification fields to candidates table
ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "bgv_status" TEXT DEFAULT 'NOT_INITIATED',
  ADD COLUMN IF NOT EXISTS "bgv_agency" TEXT,
  ADD COLUMN IF NOT EXISTS "bgv_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "bgv_initiated_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "bgv_completed_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "source_url" TEXT;

-- Add document type to candidate_documents_vault
ALTER TABLE "candidate_documents_vault"
  ADD COLUMN IF NOT EXISTS "document_type" TEXT;
