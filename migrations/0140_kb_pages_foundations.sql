-- KB Pages out-of-band FTS migration.
-- Apply AFTER 0139_kb_pages.sql has been pushed/migrated.
-- The generated fts column and GIN index are not expressible in Drizzle schema,
-- so they live here and are managed out-of-band; do not let a later db:push drop them.

ALTER TABLE kb_pages
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content_text, ''))) STORED;

CREATE INDEX IF NOT EXISTS kb_pages_fts_idx ON kb_pages USING gin (fts);
