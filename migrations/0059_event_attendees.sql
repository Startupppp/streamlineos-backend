CREATE TABLE "event_attendees" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "calendar_events"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "event_attendees_event_user_unique" UNIQUE("event_id", "user_id")
);

CREATE INDEX "idx_event_attendees_event_id" ON "event_attendees"("event_id");
CREATE INDEX "idx_event_attendees_user_id" ON "event_attendees"("user_id");
