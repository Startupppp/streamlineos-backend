CREATE TABLE IF NOT EXISTS "expense_export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "requested_by_membership_id" integer NOT NULL, "status" text NOT NULL DEFAULT 'pending',
  "filters" jsonb NOT NULL, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL,
  "file_key" text, "file_name" text, "mime_type" text NOT NULL DEFAULT 'text/csv', "file_size_bytes" bigint,
  "processed_rows" integer NOT NULL DEFAULT 0, "row_count" integer, "attempt" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3, "error_code" text, "error_message" text, "locked_at" timestamptz,
  "completed_at" timestamptz, "expires_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_expense_export_jobs_status" CHECK (status IN ('pending','running','completed','failed','expired')),
  CONSTRAINT "chk_expense_export_jobs_counts" CHECK (processed_rows >= 0 AND (row_count IS NULL OR row_count >= 0)),
  CONSTRAINT "chk_expense_export_jobs_attempts" CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT "expense_export_jobs_org_requester_membership_fk"
    FOREIGN KEY ("org_id", "requested_by_membership_id")
    REFERENCES "organization_members"("org_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_expense_export_jobs_org_idempotency" ON "expense_export_jobs" (org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS "idx_expense_export_jobs_org_status_created" ON "expense_export_jobs" (org_id, status, created_at);
CREATE INDEX IF NOT EXISTS "idx_expense_export_jobs_org_requester_created" ON "expense_export_jobs" (org_id, requested_by_membership_id, created_at);
