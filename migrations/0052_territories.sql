CREATE TABLE IF NOT EXISTS "territories" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "states" text[] DEFAULT '{}',
  "cities" text[] DEFAULT '{}',
  "assigned_reps" integer[] DEFAULT '{}',
  "description" text,
  "is_active" boolean DEFAULT true,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "territories_org_id_idx" ON "territories"("org_id");
