-- Migration: 0207_hr_attendance_regularizations
-- Idempotent: uses IF NOT EXISTS throughout

CREATE TABLE IF NOT EXISTS "hr_attendance_regularizations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "attendance_date" date NOT NULL,
  "requested_check_in" timestamp,
  "requested_check_out" timestamp,
  "reason" text NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "workflow_instance_id" text,
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "rejected_by" text REFERENCES "users"("id"),
  "rejected_at" timestamp,
  "rejection_reason" text,
  "attendance_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_att_reg_org_user" ON "hr_attendance_regularizations"("org_id","user_id");
CREATE INDEX IF NOT EXISTS "idx_att_reg_org_date" ON "hr_attendance_regularizations"("org_id","attendance_date");
CREATE INDEX IF NOT EXISTS "idx_att_reg_status" ON "hr_attendance_regularizations"("org_id","status");

ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "location_verified" boolean DEFAULT false NOT NULL;
