CREATE TABLE IF NOT EXISTS "calendar_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" text,
  "start_date" timestamp NOT NULL,
  "end_date" timestamp NOT NULL,
  "all_day" boolean DEFAULT false,
  "color" text,
  "category" text NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "attendee_ids" jsonb DEFAULT '[]',
  "is_recurring" boolean DEFAULT false,
  "recurring_rule" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_calendar_events_org_date" ON "calendar_events" ("org_id", "start_date");
CREATE INDEX IF NOT EXISTS "idx_calendar_events_category" ON "calendar_events" ("category");
CREATE INDEX IF NOT EXISTS "idx_calendar_events_created_by" ON "calendar_events" ("created_by");
