-- Rollback 0843: drop the blog post search index.
--
-- Reversible with no data loss. The index is derived entirely from `title` and
-- `excerpt`; dropping it costs the query its GIN path and nothing else, and the
-- search still returns identical results via a sequential tsvector scan.

SET lock_timeout = '5s';

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_blog_posts_search_tsvector";
