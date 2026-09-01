-- 0843: back the blog post search with a GIN index instead of a leading-wildcard scan.
--
-- `BlogService.listPosts` searched with `ILIKE '%term%'`, which §3 bans: a leading
-- wildcard cannot use a b-tree index, so every search was a sequential scan. The
-- query now uses `to_tsvector('english', title || ' ' || excerpt) @@
-- plainto_tsquery('english', $1)`, and this index is the half that makes it fast.
--
-- The index expression is byte-identical to the one the service emits. An
-- expression index is only used when the planner can match the expression
-- exactly, so any divergence — a different text search configuration, a coalesce
-- the query does not have, a different concatenation order — silently produces a
-- sequential scan that looks like the index simply did not help.
--
-- No coalesce is needed: `blog_posts.title` and `blog_posts.excerpt` are both
-- NOT NULL, so the concatenation can never be NULL.
--
-- `blog_posts` is a global table with no `org_id` and no RLS policy, so the
-- leakproof problem that forces the SECURITY DEFINER id-search seam elsewhere in
-- this schema (0275, 0424, 0425) does not apply here. There is no security qual
-- for the planner to order against, so the GIN index is reachable directly.
--
-- Not CONCURRENTLY: `db:migrate` runs each file in a transaction, where
-- CONCURRENTLY is not allowed. `lock_timeout` is what stops the build queueing
-- behind a long reader instead.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_blog_posts_search_tsvector"
  ON "blog_posts" USING gin (to_tsvector('english', "title" || ' ' || "excerpt"));
