-- 0510: Unique indexes on kb_article_chunks for idempotent ingestion replay.
--
-- (content_id, chunk_index, content_revision, acl_revision, embedding_model) must
-- be unique so that replaying a kb.content.index job for the same revision of the
-- same content writes no duplicate chunks. The delete + insert pattern in
-- KbIndexingService already prevents duplicates in the happy path; these indexes
-- close the race if two workers claim the same event before the lease expires.
--
-- Two partial indexes, one per content type, so NULL values in the opposite FK
-- column never cause spurious uniqueness violations.
--
-- NOTE: These are plain CREATE INDEX (not CONCURRENTLY) because Drizzle migrations
-- run inside a transaction and CONCURRENTLY is forbidden there. Apply the
-- CONCURRENTLY form by hand on a live database to avoid an ACCESS EXCLUSIVE lock:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     uniq_kb_chunks_article_revision
--   ON kb_article_chunks (org_id, article_id, chunk_index, content_revision, acl_revision, embedding_model)
--   WHERE article_id IS NOT NULL;
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--     uniq_kb_chunks_page_revision
--   ON kb_article_chunks (org_id, page_id, chunk_index, content_revision, acl_revision, embedding_model)
--   WHERE page_id IS NOT NULL;
--
-- Precedent: migration 0374.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_chunks_article_revision
ON kb_article_chunks (org_id, article_id, chunk_index, content_revision, acl_revision, embedding_model)
WHERE article_id IS NOT NULL AND content_revision IS NOT NULL AND acl_revision IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_chunks_page_revision
ON kb_article_chunks (org_id, page_id, chunk_index, content_revision, acl_revision, embedding_model)
WHERE page_id IS NOT NULL AND content_revision IS NOT NULL AND acl_revision IS NOT NULL;
