ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "website_url" text;
CREATE INDEX IF NOT EXISTS "idx_contacts_name_email" ON "contacts" ("org_id", "name", "email");
