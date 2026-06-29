DO $$ BEGIN
  CREATE TYPE "training_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "enrollment_status" AS ENUM ('ENROLLED', 'IN_PROGRESS', 'COMPLETED', 'DROPPED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "training_programs" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" text,
  "category" text,
  "duration" text,
  "instructor" text,
  "max_participants" integer,
  "status" "training_status" DEFAULT 'DRAFT',
  "start_date" date,
  "end_date" date,
  "location" text,
  "meeting_link" text,
  "materials" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_training_programs_org" ON "training_programs" ("org_id");

CREATE TABLE IF NOT EXISTS "training_enrollments" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "program_id" integer NOT NULL REFERENCES "training_programs"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "status" "enrollment_status" DEFAULT 'ENROLLED',
  "completed_at" timestamp,
  "score" integer,
  "feedback" text,
  "certificate_url" text,
  "enrolled_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_enrollments_program" ON "training_enrollments" ("program_id");
CREATE INDEX IF NOT EXISTS "idx_enrollments_user" ON "training_enrollments" ("user_id");
