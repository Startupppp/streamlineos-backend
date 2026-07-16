-- Workspace search index table for cited cross-module AI search (Phase 1.1).
-- DO NOT APPLY automatically; run manually in a TTY session.

CREATE TABLE IF NOT EXISTS workspace_search_chunks (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project','ticket','lead','deal','contact','client')),
  entity_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1536),
  embedding_model TEXT,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) STORED,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wsc_org_entity
  ON workspace_search_chunks (org_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_wsc_org_type
  ON workspace_search_chunks (org_id, entity_type);

CREATE INDEX IF NOT EXISTS idx_wsc_fts
  ON workspace_search_chunks USING gin (fts);

CREATE INDEX IF NOT EXISTS idx_wsc_hnsw
  ON workspace_search_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
