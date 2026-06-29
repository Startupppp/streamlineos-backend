CREATE TABLE IF NOT EXISTS "web_lead_forms" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "fields" json NOT NULL DEFAULT '[]',
  "public_token" text NOT NULL UNIQUE,
  "is_active" boolean DEFAULT true,
  "submit_message" text DEFAULT 'Thank you! We''ll be in touch soon.',
  "redirect_url" text,
  "total_submissions" integer DEFAULT 0,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "web_lead_forms_org_id_idx" ON "web_lead_forms"("org_id");
