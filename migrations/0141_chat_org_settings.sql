CREATE TABLE IF NOT EXISTS "chat_org_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "default_notification_preference" text DEFAULT 'ALL' NOT NULL,
  "max_attachment_size_mb" integer DEFAULT 25 NOT NULL,
  "max_huddle_participants" integer DEFAULT 50 NOT NULL,
  "updated_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_org_settings_org" ON "chat_org_settings" ("org_id");
