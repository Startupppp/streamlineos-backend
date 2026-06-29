DO $$ BEGIN
  CREATE TYPE "review_cycle_status" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "meeting_status" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "review_cycles" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "type" text DEFAULT 'QUARTERLY',
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "deadline" date,
  "status" "review_cycle_status" DEFAULT 'DRAFT',
  "description" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_review_cycles_org" ON "review_cycles" ("org_id");

ALTER TABLE "performance_reviews" ADD COLUMN IF NOT EXISTS "cycle_id" integer REFERENCES "review_cycles"("id");
CREATE INDEX IF NOT EXISTS "idx_perf_reviews_org_cycle" ON "performance_reviews" ("org_id", "cycle_id");
CREATE INDEX IF NOT EXISTS "idx_perf_reviews_user" ON "performance_reviews" ("user_id");

CREATE TABLE IF NOT EXISTS "one_on_one_meetings" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "manager_id" text NOT NULL REFERENCES "users"("id"),
  "employee_id" text NOT NULL REFERENCES "users"("id"),
  "scheduled_at" timestamp NOT NULL,
  "duration" integer DEFAULT 30,
  "status" "meeting_status" DEFAULT 'SCHEDULED',
  "notes" text,
  "action_items" jsonb,
  "agenda" text,
  "meeting_link" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_one_on_ones_org" ON "one_on_one_meetings" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_one_on_ones_manager" ON "one_on_one_meetings" ("manager_id");
CREATE INDEX IF NOT EXISTS "idx_one_on_ones_scheduled" ON "one_on_one_meetings" ("scheduled_at");
