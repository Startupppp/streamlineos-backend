-- 0425: bound the 0424 search helper, and let the caller detect that the bound was hit.
--
-- 0424 returned every matching id. That is ~100x faster than the seq scan for a selective
-- term, but SLOWER for a term matching most of the table, because the plain ILIKE plan is
-- a seq scan under a LIMIT and stops as soon as it has enough rows, whereas a set-returning
-- function is materialised in full first. Measured on 204k tickets, LIMIT 20:
--
--   term                matches    plain ILIKE    0424 function
--   'ticket'            200,000           1 ms          434 ms   <- regression
--   '199999'                  1         208 ms            2 ms
--   'Seed ticket 12345'      11         225 ms           12 ms
--
-- So the function now takes a limit and the caller asks for cap+1 ids. Getting cap+1 back
-- means the term is too broad to be worth an id list, and the caller falls back to plain
-- ILIKE -- which is the fast plan in exactly that case. Both regimes take the good path and
-- results stay exact, because the id list is only used when it is known to be complete.
--
-- Same safety properties as 0424: org from app.current_org_id() and never a parameter, ids
-- only and never row data, the caller's own query still runs under RLS with its DataScope
-- clause, EXECUTE revoked from PUBLIC.

DROP FUNCTION IF EXISTS app.search_ticket_ids(text);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_ticket_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT t.id
  FROM public.tickets t
  WHERE t.org_id = app.current_org_id()
    AND t.deleted_at IS NULL
    AND t.title ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_ticket_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_ticket_ids(text, integer) TO streamline_app;
