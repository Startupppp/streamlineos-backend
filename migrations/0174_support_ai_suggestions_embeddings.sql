-- Phase 6: AI assistant suggestions + ticket embeddings for duplicate detection.
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE support_suggestion_type AS ENUM (
    'summary', 'sentiment', 'category', 'priority', 'spam', 'reply', 'macro', 'kb_article', 'duplicate'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE support_suggestion_status AS ENUM ('pending', 'accepted', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS support_ai_suggestions (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  type support_suggestion_type NOT NULL,
  payload JSONB NOT NULL,
  confidence NUMERIC(4, 3),
  status support_suggestion_status NOT NULL DEFAULT 'pending',
  feedback TEXT,
  resolved_at TIMESTAMP,
  resolved_by TEXT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ai_suggestions_ticket ON support_ai_suggestions (ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_ai_suggestions_org_type ON support_ai_suggestions (org_id, type);
CREATE INDEX IF NOT EXISTS idx_support_ai_suggestions_status ON support_ai_suggestions (status);

CREATE TABLE IF NOT EXISTS support_ticket_embeddings (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_ticket_embeddings_ticket ON support_ticket_embeddings (ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_ticket_embeddings_org ON support_ticket_embeddings (org_id);
CREATE INDEX IF NOT EXISTS support_ticket_embeddings_hnsw
  ON support_ticket_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
