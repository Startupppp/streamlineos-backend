-- 0275: the lead list's text search, moved onto Party.
--
-- The leads module now reads `business_parties` through `lead_party_map` rather
-- than `leads`, so the four trigram indexes that made its search usable are on
-- the wrong table, and `app.search_lead_ids_by_company` searches a table ticket
-- 08 is going to drop. Both move here, unchanged in shape.
--
-- Why a function at all is 0454's argument and it has not changed: under RLS the
-- `textlike` operator behind ILIKE is not leakproof, so the planner may not
-- evaluate it before the security qual and skips the GIN index entirely.
-- `ALTER FUNCTION ... LEAKPROOF` is impossible on Neon (no true superuser), so a
-- SECURITY DEFINER function owned by the BYPASSRLS owner is the only escape. The
-- same five conditions hold: org comes from `app.current_org_id()` and never
-- from a parameter (so it fails closed 42501 with no GUC), it returns ids and
-- never row data, the caller's own query still runs under RLS with its
-- DataScope, EXECUTE is revoked from PUBLIC, and the caller asks for cap+1 so it
-- can fall back to plain ILIKE once the term is too broad for an id list to pay
-- for itself.
--
-- Not CONCURRENTLY: `db:migrate` runs each file in a transaction, where
-- CONCURRENTLY is not allowed, and `business_parties` is one row per legacy
-- record rather than a table with its own history. `lock_timeout` is what keeps
-- a build from queueing behind a long reader instead.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_name_trgm"
  ON "business_parties" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_email_trgm"
  ON "business_parties" USING gin ("email" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_phone_trgm"
  ON "business_parties" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_company_trgm"
  ON "business_parties" USING gin ("company_name" gin_trgm_ops);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_party_ids_by_company(p_q text, p_limit integer)
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
    AND p.company_name ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_party_ids_by_company(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_party_ids_by_company(text, integer) TO streamline_app;

--> statement-breakpoint
ANALYZE "business_parties";
