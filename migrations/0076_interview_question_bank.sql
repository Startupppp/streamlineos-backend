CREATE TABLE IF NOT EXISTS "interview_questions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  "category" text NOT NULL DEFAULT 'GENERAL',
  "role" text,
  "difficulty" text NOT NULL DEFAULT 'MEDIUM',
  "tags" text[] DEFAULT '{}',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_interview_questions_org" ON "interview_questions"("org_id");
CREATE INDEX IF NOT EXISTS "idx_interview_questions_category" ON "interview_questions"("org_id", "category");

CREATE TABLE IF NOT EXISTS "candidate_reference_checks" (
  "id" serial PRIMARY KEY,
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "reference_name" text NOT NULL,
  "reference_designation" text,
  "reference_company" text,
  "reference_email" text,
  "reference_phone" text,
  "relationship" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "outcome" text,
  "notes" text,
  "contacted_at" timestamp,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_reference_checks_candidate" ON "candidate_reference_checks"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_reference_checks_org" ON "candidate_reference_checks"("org_id");
