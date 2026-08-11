-- Rollback for 0425: restores the unbounded 0424 signature.
DROP FUNCTION IF EXISTS app.search_ticket_ids(text, integer);

CREATE OR REPLACE FUNCTION app.search_ticket_ids(p_q text)
RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT t.id FROM public.tickets t
  WHERE t.org_id = app.current_org_id()
    AND t.deleted_at IS NULL
    AND t.title ILIKE '%' || p_q || '%'
$$;
REVOKE ALL ON FUNCTION app.search_ticket_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_ticket_ids(text) TO streamline_app;
