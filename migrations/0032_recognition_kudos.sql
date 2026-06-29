CREATE TABLE IF NOT EXISTS "recognitions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "from_user_id" text NOT NULL REFERENCES "users"("id"),
  "to_user_id" text NOT NULL REFERENCES "users"("id"),
  "message" text NOT NULL,
  "category" text DEFAULT 'KUDOS',
  "is_public" boolean DEFAULT true,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_recognitions_org" ON "recognitions" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_recognitions_to_user" ON "recognitions" ("to_user_id");
