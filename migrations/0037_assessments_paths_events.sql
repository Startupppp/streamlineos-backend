CREATE TABLE IF NOT EXISTS "skill_assessments" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "skill_name" text NOT NULL,
  "questions" jsonb,
  "passing_score" integer DEFAULT 70,
  "time_limit" integer,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_skill_assessments_org" ON "skill_assessments" ("org_id");

CREATE TABLE IF NOT EXISTS "assessment_attempts" (
  "id" serial PRIMARY KEY,
  "assessment_id" integer NOT NULL REFERENCES "skill_assessments"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "answers" jsonb,
  "score" integer,
  "passed" boolean DEFAULT false,
  "completed_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_assessment_attempts_user" ON "assessment_attempts" ("user_id");

CREATE TABLE IF NOT EXISTS "learning_paths" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" text,
  "target_role" text,
  "steps" jsonb,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_learning_paths_org" ON "learning_paths" ("org_id");

CREATE TABLE IF NOT EXISTS "team_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" text,
  "type" text DEFAULT 'TEAM_BUILDING',
  "date" date NOT NULL,
  "time" text,
  "location" text,
  "max_participants" integer,
  "organized_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_team_events_org" ON "team_events" ("org_id");

CREATE TABLE IF NOT EXISTS "team_event_participants" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL REFERENCES "team_events"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "status" text DEFAULT 'GOING',
  "joined_at" timestamp DEFAULT now()
);
