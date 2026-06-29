CREATE TABLE IF NOT EXISTS "content_calendar_items" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "title" text NOT NULL,
  "content_type" text NOT NULL DEFAULT 'blog',
  "channel" text,
  "status" text DEFAULT 'idea',
  "scheduled_date" date,
  "published_date" date,
  "assigned_to" text REFERENCES "users"("id"),
  "description" text,
  "tags" text[] DEFAULT '{}',
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "content_calendar_org_id_idx" ON "content_calendar_items"("org_id");
CREATE INDEX IF NOT EXISTS "content_calendar_scheduled_date_idx" ON "content_calendar_items"("scheduled_date");
