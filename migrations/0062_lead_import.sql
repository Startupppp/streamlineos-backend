CREATE TABLE IF NOT EXISTS "lead_import_batches" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "filename" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "imported_rows" INTEGER NOT NULL DEFAULT 0,
  "failed_rows" INTEGER NOT NULL DEFAULT 0,
  "error_report" JSONB,
  "created_at" TIMESTAMP DEFAULT NOW(),
  "completed_at" TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_lead_batches_org" ON "lead_import_batches"("org_id");
