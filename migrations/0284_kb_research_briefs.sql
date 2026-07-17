CREATE TABLE IF NOT EXISTS "kb_research_briefs" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "topic" text NOT NULL,
  "space_id" integer,
  "status" text NOT NULL DEFAULT 'queued',
  "job_id" integer,
  "source_count" integer NOT NULL DEFAULT 0,
  "report" text,
  "citations" jsonb,
  "error_message" text,
  "rating" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_kb_research_briefs_org" ON "kb_research_briefs" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_kb_research_briefs_org_user" ON "kb_research_briefs" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_kb_research_briefs_job" ON "kb_research_briefs" ("job_id");
