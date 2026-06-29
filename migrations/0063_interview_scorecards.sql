CREATE TABLE IF NOT EXISTS "scorecard_templates" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "name" TEXT NOT NULL,
  "criteria" JSONB NOT NULL DEFAULT '[]',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_scorecard_templates_org" ON "scorecard_templates"("org_id");

CREATE TABLE IF NOT EXISTS "interview_scorecards" (
  "id" SERIAL PRIMARY KEY,
  "interview_id" INTEGER NOT NULL REFERENCES "interviews"("id") ON DELETE CASCADE,
  "interviewer_id" TEXT NOT NULL REFERENCES "users"("id"),
  "template_id" INTEGER REFERENCES "scorecard_templates"("id"),
  "ratings" JSONB NOT NULL DEFAULT '{}',
  "recommendation" TEXT NOT NULL DEFAULT 'MAYBE',
  "notes" TEXT,
  "is_blind_mode" BOOLEAN NOT NULL DEFAULT false,
  "submitted_at" TIMESTAMP,
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_scorecards_interview" ON "interview_scorecards"("interview_id");
CREATE INDEX IF NOT EXISTS "idx_scorecards_interviewer" ON "interview_scorecards"("interviewer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_scorecard_interview_interviewer" ON "interview_scorecards"("interview_id", "interviewer_id");

CREATE TABLE IF NOT EXISTS "candidate_documents_vault" (
  "id" SERIAL PRIMARY KEY,
  "candidate_id" INTEGER NOT NULL,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "filename" TEXT NOT NULL,
  "s3_key" TEXT NOT NULL,
  "file_url" TEXT NOT NULL,
  "file_type" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL DEFAULT 0,
  "av_result" TEXT NOT NULL DEFAULT 'PENDING',
  "uploaded_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_vault_candidate" ON "candidate_documents_vault"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_vault_org" ON "candidate_documents_vault"("org_id");

CREATE TABLE IF NOT EXISTS "vault_access_logs" (
  "id" SERIAL PRIMARY KEY,
  "vault_document_id" INTEGER NOT NULL REFERENCES "candidate_documents_vault"("id") ON DELETE CASCADE,
  "accessed_by" TEXT NOT NULL REFERENCES "users"("id"),
  "action" TEXT NOT NULL DEFAULT 'VIEW',
  "accessed_at" TIMESTAMP DEFAULT NOW()
);
