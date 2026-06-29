ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "mfa_enforced" boolean NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "password_expiry_days" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp;
CREATE TABLE IF NOT EXISTS "mfa_backup_codes" (
  "id" serial PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_mfa_backup_codes_user" ON "mfa_backup_codes" ("user_id");
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "device_id" text;
