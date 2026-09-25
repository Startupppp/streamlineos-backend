SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kb_pages_tree_children
  ON kb_pages (org_id, parent_page_id, sort_order, id)
  WHERE deleted_at IS NULL;
