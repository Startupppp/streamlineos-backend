CREATE TABLE IF NOT EXISTS "hr_access_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_id" text NOT NULL,
  "system_name" text NOT NULL,
  "access_level" text NOT NULL,
  "status" text NOT NULL DEFAULT 'requested',
  "granted_by" text,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_hr_access_requests_org" ON "hr_access_requests" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_hr_access_requests_employee" ON "hr_access_requests" ("employee_id");
