CREATE TABLE IF NOT EXISTS "support_ai_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "confidence_threshold" numeric(4,3) DEFAULT '0.7' NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_support_ai_settings_org" UNIQUE("org_id")
);
