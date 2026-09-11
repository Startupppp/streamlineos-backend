-- 1000 DOWN — removes the three plan-measured indexes and restores the materialised
-- CTE form of app.search_kb_chunk_ids exactly as it was shipped.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_calendar_events_org_recurring_start;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_calendar_events_org_start_cover;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_tickets_org_updated_live;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_chunk_ids(p_vec vector, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  WITH org_chunks AS MATERIALIZED (
    SELECT c.id, c.embedding
    FROM public.kb_article_chunks c
    WHERE c.org_id = app.current_org_id()
  )
  SELECT id
  FROM org_chunks
  ORDER BY embedding <=> p_vec
  LIMIT p_limit
$function$;
