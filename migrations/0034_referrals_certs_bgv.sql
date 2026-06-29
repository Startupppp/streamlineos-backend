ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "referred_by" text REFERENCES "users"("id");

CREATE TABLE IF NOT EXISTS "certifications" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "issuing_organization" text,
  "issue_date" date,
  "expiry_date" date,
  "credential_id" text,
  "credential_url" text,
  "document_url" text,
  "reminder_sent" boolean DEFAULT false,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_certifications_user" ON "certifications" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_certifications_expiry" ON "certifications" ("expiry_date");

CREATE TABLE IF NOT EXISTS "background_verifications" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "type" text NOT NULL,
  "status" text DEFAULT 'PENDING',
  "provider" text,
  "reference_number" text,
  "result" text,
  "notes" text,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_bgv_user" ON "background_verifications" ("user_id");
