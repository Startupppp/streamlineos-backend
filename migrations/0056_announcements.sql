CREATE TABLE IF NOT EXISTS "announcements" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "author_id" text NOT NULL REFERENCES "users"("id"),
  "content" text NOT NULL,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_announcements_org" ON "announcements" ("org_id", "expires_at");
