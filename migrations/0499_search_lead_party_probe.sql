-- 0499: comprehensive lead-party id probe covering all four searchable columns.
--
-- The lead branch in search.service.ts had four branches in its OR clause: three
-- raw ILIKE calls on business_parties.name / email / phone, plus a call to
-- search_party_ids_by_company (0275) for company_name. Under RLS the textlike
-- operator is proleakproof=false, so the planner cannot evaluate those three
-- ILIKEs before the security qual and falls back to sequential scans regardless
-- of the trigram indexes 0275 already created.
--
-- A single SECURITY DEFINER function covering all four columns lets the probe
-- return party_ids in one indexed call, and the caller replaces the four-branch
-- OR with a single inArray predicate. The same five conditions apply as every
-- prior probe:
--   1. Org from app.current_org_id() — never a parameter; fails closed 42501.
--   2. Returns ids only; the caller's outer query still runs under RLS.
--   3. EXECUTE revoked from PUBLIC, granted to streamline_app.
--   4. Takes a limit.
--   5. Caller asks cap+1 and falls back to plain ILIKE when the cap is hit.
--
-- No new indexes needed: 0275 already created all four GIN trigram indexes
-- (idx_business_parties_name_trgm, idx_business_parties_email_trgm,
--  idx_business_parties_phone_trgm, idx_business_parties_company_trgm).
--
-- Not CONCURRENTLY: db:migrate wraps each file in a transaction.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_lead_party_ids(p_q text, p_limit integer)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT p.party_id
  FROM public.business_parties p
  WHERE p.organization_id = app.current_org_id()
    AND p.deleted_at IS NULL
    AND (
      p.name ILIKE '%' || p_q || '%'
      OR p.email ILIKE '%' || p_q || '%'
      OR p.phone ILIKE '%' || p_q || '%'
      OR p.company_name ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.search_lead_party_ids(text, integer) FROM PUBLIC;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.search_lead_party_ids(text, integer) TO streamline_app;

--> statement-breakpoint
ANALYZE "business_parties";
