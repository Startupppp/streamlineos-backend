-- Migration 0280: support knowledge gaps table
-- DO NOT APPLY manually; run via db:migrate

CREATE TABLE IF NOT EXISTS "support_knowledge_gaps" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "cluster_key" varchar(500) NOT NULL,
  "representative_question" text NOT NULL,
  "ticket_count" integer NOT NULL DEFAULT 0,
  "sample_ticket_ids" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'OPEN',
  "proposed_article_id" integer REFERENCES "kb_articles"("id") ON DELETE SET NULL,
  "drafted_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "evidence" jsonb NOT NULL DEFAULT '{"searchQueries":[],"relatedTicketIds":[]}',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_knowledge_gaps_org_cluster"
  ON "support_knowledge_gaps" ("org_id", "cluster_key");

CREATE INDEX IF NOT EXISTS "idx_support_knowledge_gaps_org_status_created"
  ON "support_knowledge_gaps" ("org_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "idx_support_knowledge_gaps_org"
  ON "support_knowledge_gaps" ("org_id");
