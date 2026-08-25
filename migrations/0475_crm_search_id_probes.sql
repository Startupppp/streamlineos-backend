-- 0475: id-probe functions for the three global-search CRM branches that lacked them.
--
-- The problem is identical to 0425 (tickets) and 0275 (leads): under RLS the
-- `textlike` operator behind ILIKE is proleakproof=false, so the planner may not
-- evaluate the text predicate before the security qual and falls back to a
-- sequential scan. ALTER FUNCTION ... LEAKPROOF is impossible on Neon (no true
-- superuser; neondb_owner/neon_superuser are rolsuper=false, so the command fails
-- 42501 even in the console).
--
-- The escape is a SECURITY DEFINER function owned by the BYPASSRLS owner. Inside
-- it the planner runs outside the security barrier and can use the GIN index. The
-- same five conditions hold for every probe here:
--   1. Org comes from app.current_org_id() and never from a parameter — a missing
--      GUC fails closed with 42501.
--   2. Returns ids only, never row data — the caller's outer query still runs
--      under RLS with its own DataScope (deleted_at, scope restrictions, etc.).
--   3. EXECUTE revoked from PUBLIC and granted to streamline_app only.
--   4. Takes a limit.
--   5. The caller asks for cap+1 and falls back to plain ILIKE when the cap is
--      hit — an unbounded SRF is materialised in full and is slower than the
--      seq scan it replaced for a broad term (measured 434ms vs 1ms on 0425).
--
-- Indexes for contacts and clients: the four trigram indexes 0275 created on
-- business_parties (name, email, phone, company_name) already cover both probes.
-- No new indexes are needed for those two.
--
-- Indexes for deals: deals.name and deals.contact_person have no trigram index
-- yet. Created below. Not CONCURRENTLY: db:migrate wraps each file in a
-- transaction and CONCURRENTLY is not allowed inside one. lock_timeout keeps the
-- build from queueing behind a long reader instead.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_name_trgm"
  ON "deals" USING gin ("name" gin_trgm_ops);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_contact_person_trgm"
  ON "deals" USING gin ("contact_person" gin_trgm_ops);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_deal_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT d.id
  FROM public.deals d
  WHERE d.org_id = app.current_org_id()
    AND d.deleted_at IS NULL
    AND (d.name ILIKE '%' || p_q || '%' OR d.contact_person ILIKE '%' || p_q || '%')
  LIMIT p_limit
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.search_deal_ids(text, integer) FROM PUBLIC;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.search_deal_ids(text, integer) TO streamline_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_contact_party_ids(p_q text, p_limit integer)
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
      OR p.company_name ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.search_contact_party_ids(text, integer) FROM PUBLIC;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.search_contact_party_ids(text, integer) TO streamline_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_client_party_ids(p_q text, p_limit integer)
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
    AND (p.name ILIKE '%' || p_q || '%' OR p.company_name ILIKE '%' || p_q || '%')
  LIMIT p_limit
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.search_client_party_ids(text, integer) FROM PUBLIC;

--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.search_client_party_ids(text, integer) TO streamline_app;

--> statement-breakpoint
ANALYZE "deals";
