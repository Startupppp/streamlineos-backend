CREATE TABLE IF NOT EXISTS "user_module_access" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "module_key" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_module_access_org_user_module" ON "user_module_access" ("org_id", "user_id", "module_key");
CREATE INDEX IF NOT EXISTS "idx_user_module_access_org_user" ON "user_module_access" ("org_id", "user_id");
