-- Add soft-delete and merge tracking columns to leads
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "merged_into_id" INTEGER REFERENCES "leads"("id");

CREATE INDEX IF NOT EXISTS "idx_leads_deleted_at" ON "leads" ("deleted_at");
