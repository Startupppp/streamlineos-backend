-- Ticket Watchers: users who want to be notified about ticket changes
CREATE TABLE IF NOT EXISTS "ticket_watchers" (
  "id" serial PRIMARY KEY NOT NULL,
  "ticket_id" integer NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ticket_watcher" ON "ticket_watchers" ("ticket_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_ticket_watchers_user" ON "ticket_watchers" ("user_id");
