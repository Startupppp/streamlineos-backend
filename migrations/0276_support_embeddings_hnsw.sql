-- HNSW index on support_ticket_embeddings for fast cosine-distance duplicate detection.
-- Mirrors the style of 0118_kb_foundations.sql.
-- DO NOT APPLY automatically; run manually in a TTY session.

CREATE INDEX IF NOT EXISTS idx_support_ticket_embeddings_hnsw
  ON support_ticket_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
