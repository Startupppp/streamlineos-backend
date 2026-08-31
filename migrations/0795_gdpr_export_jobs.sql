SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gdpr_export_jobs" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "subject_user_id" text NOT NULL,
  "requested_by" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "file_key" text,
  "file_name" text,
  "file_size_bytes" bigint,
  "row_count" integer,
  "truncated" boolean DEFAULT false NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "error_code" text,
  "error_message" text,
  "locked_at" timestamptz,
  "completed_at" timestamptz,
  "expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chk_gdpr_export_jobs_status" CHECK (status IN ('pending','running','completed','failed','expired')),
  CONSTRAINT "chk_gdpr_export_jobs_attempts" CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "gdpr_export_jobs"
  ADD CONSTRAINT "gdpr_export_jobs_org_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "gdpr_export_jobs" VALIDATE CONSTRAINT "gdpr_export_jobs_org_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gdpr_export_jobs_org_idempotency"
  ON "gdpr_export_jobs" ("org_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_gdpr_export_jobs_org_status_created"
  ON "gdpr_export_jobs" ("org_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "idx_gdpr_export_jobs_org_subject_created"
  ON "gdpr_export_jobs" ("org_id", "subject_user_id", "created_at");
