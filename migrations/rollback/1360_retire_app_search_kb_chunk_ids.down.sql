-- Rollback for 1360: Restore app.search_kb_chunk_ids to the form shipped by
-- migration 1000 (bare SELECT, no MATERIALIZED CTE).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_chunk_ids(p_vec vector, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  SELECT c.id
  FROM public.kb_article_chunks c
  WHERE c.org_id = app.current_org_id()
  ORDER BY c.embedding <=> p_vec
  LIMIT p_limit
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_chunk_ids(vector, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_chunk_ids(vector, integer) TO streamline_app;
