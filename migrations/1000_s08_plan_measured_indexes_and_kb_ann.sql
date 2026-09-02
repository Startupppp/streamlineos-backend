-- Four changes ticket 20 measured against a seeded three-tenant database as the
-- non-owner app role with the tenant GUC set, not as the owner. The distinction
-- matters: the same trigram index that answers a ticket search in 106 buffers for
-- neondb_owner is skipped for streamline_app, which seq-scans 393. Every number
-- below is the app role's.
--
-- 1-2. calendar_events. The recurring branch walks (org_id, start_date) over all
--      60,000 events to return 500 -- 3,507 buffers, 2,995 rows discarded -- while
--      only 8,569 rows carry an rrule. And the free/busy conflict count references
--      only (end_date, rrule, recurrence_end) yet seq-scans: 1,730 buffers, 66,613
--      rows read to return one number. org_id is in the key of the covering index,
--      not the INCLUDE list, because an index-only scan on an RLS table must be able
--      to satisfy the policy predicate from the index.
--
-- 3.   build.tickets has no (org_id, updated_at) index, so the dashboard recent-
--      activity read seq-scans 19,587 rows to return 10 (417 buffers). Partial on
--      deleted_at IS NULL because every list read filters it.
--
-- 4.   app.search_kb_chunk_ids is the largest single win measured. Its body wraps the
--      organisation's chunks in a CTE marked AS MATERIALIZED, which forbids pushing the
--      ORDER BY into idx_kb_chunks_embedding_hnsw, so every call materialises the whole
--      corpus of 1536-dimension vectors and sorts it: 36,882 buffers on a 12,000-chunk
--      tenant against 1,379 for the same body without the CTE. It is ~3.0 buffers per
--      chunk in the organisation at every tenant size -- linear, with no index -- so a
--      500,000-chunk tenant would move roughly 1.5M buffers per search. Removing the
--      CTE is strictly better at all three measured sizes, because where the planner
--      declines HNSW it falls back to exactly the scan the CTE forces today.
--
--      Every property backend/CLAUDE.md requires of this function is preserved: the
--      organisation comes from app.current_org_id() and is never a parameter, so a call
--      with no GUC fails closed 42501; it returns ids only; it stays SECURITY DEFINER
--      owned by the BYPASSRLS owner so it is not inlined into the caller's security
--      barrier; the caller's own query still runs under RLS; and it keeps its LIMIT
--      argument so the set-returning function is never materialised unbounded.
--      CREATE OR REPLACE preserves the existing ACL (EXECUTE to streamline_app only).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_recurring_start
  ON calendar_events (org_id, start_date)
  WHERE rrule IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_start_cover
  ON calendar_events (org_id, start_date)
  INCLUDE (end_date, rrule, recurrence_end);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_tickets_org_updated_live
  ON build.tickets (org_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'search_kb_chunk_ids'
      AND (p.prosrc ILIKE '%MATERIALIZED%' OR p.prosecdef IS NOT TRUE
           OR p.prosrc NOT ILIKE '%current_org_id()%'
           OR p.prosrc NOT ILIKE '%p_limit%')
  ) THEN
    RAISE EXCEPTION 'app.search_kb_chunk_ids lost a required property';
  END IF;
END $$;
