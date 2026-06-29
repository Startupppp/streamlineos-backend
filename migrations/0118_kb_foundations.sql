-- KB Phase 0 foundations: enum value, full-text search, HNSW vector index, default-space backfill.
-- Apply AFTER the Drizzle schema changes are pushed (`pnpm db:push` / `db:migrate`), which create
-- kb_spaces, kb_articles.content_text, kb_articles.space_id, kb_categories.space_id and friends.
-- The `fts` generated columns and the HNSW index are not expressible in Drizzle, so they live here
-- and are managed out-of-band; do not let a later `db:push` drop them.

-- 1. pgvector (already used by kb_article_chunks; safe to re-run).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. New article status value. ADD VALUE cannot run inside a transaction on older Postgres;
--    run this statement on its own if your client wraps the file in one.
ALTER TYPE "kb_article_status" ADD VALUE IF NOT EXISTS 'in_review';

-- 3. Default "General" space per org, then attach existing articles + categories to it.
INSERT INTO kb_spaces (org_id, name, slug, audience, is_public_help_center)
SELECT DISTINCT org_id, 'General', 'general', 'mixed', true
FROM (
  SELECT org_id FROM kb_articles
  UNION
  SELECT org_id FROM kb_categories
) orgs
ON CONFLICT (org_id, slug) DO NOTHING;

UPDATE kb_articles a
SET space_id = sp.id
FROM kb_spaces sp
WHERE sp.org_id = a.org_id AND sp.slug = 'general' AND a.space_id IS NULL;

UPDATE kb_categories c
SET space_id = sp.id
FROM kb_spaces sp
WHERE sp.org_id = c.org_id AND sp.slug = 'general' AND c.space_id IS NULL;

-- 4. Full-text search on articles (title + derived plaintext) and on RAG chunks.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content_text, ''))) STORED;
CREATE INDEX IF NOT EXISTS kb_articles_fts_idx ON kb_articles USING gin (fts);

ALTER TABLE kb_article_chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS kb_article_chunks_fts_idx ON kb_article_chunks USING gin (fts);

-- 5. HNSW index for semantic retrieval (cosine). Requires pgvector >= 0.5.0.
CREATE INDEX IF NOT EXISTS kb_article_chunks_embedding_hnsw
  ON kb_article_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
