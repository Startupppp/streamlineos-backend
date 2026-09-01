SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_quarantine_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "storage_key" text NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_scan',
  "threat_name" text,
  "idempotency_key" text,
  "uploaded_by" text NOT NULL,
  "scanned_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_quarantine_records"
  ADD CONSTRAINT "chk_fqr_status"
  CHECK ("status" IN ('pending_scan', 'clean', 'infected', 'error'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fqr_org_status_created"
  ON "file_quarantine_records" ("org_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fqr_org_sha256"
  ON "file_quarantine_records" ("org_id", "sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fqr_idempotency_key"
  ON "file_quarantine_records" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fqr_org_key_active"
  ON "file_quarantine_records" ("org_id", "storage_key")
  WHERE "deleted_at" IS NULL;
