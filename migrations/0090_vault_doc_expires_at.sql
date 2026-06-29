-- Add expiry date to candidate_documents_vault for certifications/passports
ALTER TABLE "candidate_documents_vault" ADD COLUMN IF NOT EXISTS "expires_at" date;
