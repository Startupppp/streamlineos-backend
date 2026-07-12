CREATE TABLE IF NOT EXISTS "ticket_related_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "ticket_id" integer NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "label" text,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_ticket_related_links_ticket" ON "ticket_related_links" ("ticket_id");
