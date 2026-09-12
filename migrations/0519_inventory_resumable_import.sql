SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-108. The importer accepted up to 10,000 rows inside the request body and
-- processed every one of them synchronously, inside the request's transaction,
-- with the errors accumulated in memory. A 100,000-row import — which the PRD
-- requires — could not be expressed, and a failure at row 9,000 lost the 8,999
-- before it with nothing to resume from.
--
-- Rows are staged first and processed against a cursor, so a crash costs at most
-- one chunk and a resume is just "call process again". Per-row status is what
-- makes a re-run skip what already applied rather than double-posting it.
CREATE TYPE inv_import_row_status AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'SKIPPED');
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "checksum" text;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "chunk_size" integer NOT NULL DEFAULT 500;
--> statement-breakpoint
-- The resume point. Rows below it have an outcome; rows at or above it do not.
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "next_row" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "staged_rows" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "started_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
--> statement-breakpoint
-- Re-submitting the same file must find the job it already made, not make a
-- second one that imports everything twice.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_import_jobs_org_idempotency"
  ON "inv_import_jobs" ("org_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inv_import_rows" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "job_id" integer NOT NULL,
  "row_number" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "status" inv_import_row_status NOT NULL DEFAULT 'PENDING',
  "error_code" text,
  "error_field" text,
  "error_message" text,
  "applied_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_import_rows_org_id_fk') THEN
    ALTER TABLE "inv_import_rows" ADD CONSTRAINT "inv_import_rows_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_import_rows_job_id_org') THEN
    ALTER TABLE "inv_import_rows" ADD CONSTRAINT "fk_inv_import_rows_job_id_org"
      FOREIGN KEY ("org_id", "job_id") REFERENCES "inv_import_jobs"("org_id", "id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_inv_import_rows_org_id') THEN
    ALTER TABLE "inv_import_rows" ADD CONSTRAINT "uniq_inv_import_rows_org_id" UNIQUE ("org_id", "id");
  END IF;
END $$;
--> statement-breakpoint
-- One row per position in the file: staging a chunk twice cannot duplicate it.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_import_rows_job_row"
  ON "inv_import_rows" ("org_id", "job_id", "row_number");
--> statement-breakpoint
-- The claim query: next PENDING rows for a job, in file order.
CREATE INDEX IF NOT EXISTS "idx_inv_import_rows_job_status_row"
  ON "inv_import_rows" ("org_id", "job_id", "status", "row_number");
--> statement-breakpoint
ALTER TABLE "inv_import_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_import_rows";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_import_rows"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
