SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kb_sources_org_space_indexed
  ON kb_sources (org_id, space_id)
  WHERE chunk_count > 0 AND deleted_at IS NULL;
