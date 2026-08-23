-- 0454: restore idx_leads_company_trgm under RLS for the CRM lead list search.
--
-- idx_leads_company_trgm is a GIN trigram index on leads.company. Under RLS
-- the textlike operator (used by ILIKE) is proleakproof=false, so the planner
-- cannot evaluate the index predicate before the security qual and falls back
-- to a seq scan across the whole org. ALTER FUNCTION ... LEAKPROOF is
-- impossible on Neon (no true superuser; neondb_owner/neon_superuser are
-- rolsuper=false).
--
-- A SECURITY DEFINER function owned by the BYPASSRLS owner runs outside the
-- security barrier, allowing the planner to use the trigram GIN index. Safety:
-- org comes from app.current_org_id() inside the function and never from a
-- parameter (fails closed 42501 with no GUC), returns ids only and never row
-- data, the caller's outer query still runs under RLS with its own DataScope
-- (deleted_at filter, status, scope restrictions), and EXECUTE is revoked from
-- PUBLIC.
--
-- The caller requests cap+1 ids. Getting cap+1 back means the term is too
-- broad to be worth an id list, so the caller falls back to plain ILIKE on
-- the company column (same strategy as 0425 on tickets).

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION app.search_lead_ids_by_company(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT l.id
  FROM public.leads l
  WHERE l.org_id = app.current_org_id()
    AND l.deleted_at IS NULL
    AND l.company ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_lead_ids_by_company(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_lead_ids_by_company(text, integer) TO streamline_app;
