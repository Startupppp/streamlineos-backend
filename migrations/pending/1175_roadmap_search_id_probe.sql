-- 1175: index-backed roadmap item search under RLS.
--
-- Rollback: migrations/pending/1175_roadmap_search_id_probe.down.sql
--
-- UNJOURNALLED ON PURPOSE. Not registered in meta/_journal.json, so drizzle-kit migrate
-- will not run it. Preconditions for moving it up are at the bottom of this header.
--
-- The defect it answers. build.roadmap_items carries exactly one index besides its keys:
--
--   idx_roadmap_items_org_status ON (org_id, status) WHERE deleted_at IS NULL
--
-- and src/modules/build/core/projects-roadmap.service.ts searched it with
--
--   ILIKE '%' || q || '%' ON title OR ILIKE '%' || q || '%' ON description
--
-- Two leading wildcards OR'd across two unindexed columns. There is no index on either
-- column, so that is a sequential scan of every live roadmap item in the tenant on every
-- keystroke, and no index added to those columns would have changed it: search operators
-- are not leakproof, so under an RLS security qual texticlike can never be promoted to an
-- index condition. That is measured elsewhere on this platform at 12,036 buffers / 134.8ms
-- as streamline_app against 16 buffers / 0.34ms as the BYPASSRLS owner for the SAME query
-- and data, and ALTER FUNCTION ... LEAKPROOF is not available (Neon grants no superuser).
--
-- So the fix is the one this repository already ships five times -- 0425 search_ticket_ids,
-- 0475 search_deal_ids / search_contact_party_ids / search_client_party_ids, 0499
-- search_lead_party_ids -- and not a new index on a column the app cannot reach:
--
--   a SECURITY DEFINER function, owned by the BYPASSRLS role, whose body escapes the
--   security barrier (Postgres does not inline SECURITY DEFINER), returning IDS ONLY.
--
-- Safety rests here rather than in a policy, and is identical to 0425's:
--   * org comes from app.current_org_id() and never from a parameter, so it fails closed
--     with 42501 when the tenant GUC is absent rather than reading across tenants;
--   * it returns ids and never row data, so the caller's own query still runs under RLS
--     with its DataScope clause and the bypass cannot widen who sees what;
--   * EXECUTE is revoked from PUBLIC.
--
-- Bounded, for 0425's reason. An unbounded set-returning function is materialised in full
-- before the caller's LIMIT applies, which is SLOWER than the seq scan for a broad term
-- (0425 measured 434ms against 1ms on 204k tickets). The caller asks for cap+1 ids; cap+1
-- back means the term is too broad to be worth an id list and the caller falls back to
-- plain ILIKE, which is the fast plan in exactly that case. Results stay exact because the
-- id list is only used when it is known to be complete.
--
-- Both columns stay in the predicate. Inside the function there is no RLS, so texticlike
-- IS index-eligible and the planner can BitmapOr the two trigram indexes; the OR that
-- defeats every index in the caller's query is servable here. The caller's observable
-- behaviour is therefore unchanged -- same rows, same columns -- which is what
-- projects-roadmap-search-probe.spec.ts pins.
--
-- The two indexes are created here and DELIBERATELY NOT declared in
-- src/db/schema/build/roadmap.ts. migrations/pending/README.md's standing rule is that
-- nothing in this directory may be the only creator of an object that src/db/schema/**
-- declares, because a file here never runs and a Drizzle declaration naming such an object
-- is a promise about the live database that nothing keeps. Declaring them would break that
-- rule; the function is not a Drizzle-declarable object at all.
--
-- Preconditions before moving this up into migrations/ and registering it:
--   1. pg_trgm present in the target database. idx_projects_name_trgm already uses
--      gin_trgm_ops, so this holds today, but it is the one thing that makes the file fail.
--   2. The streamline_app role exists in the target and is the role the API connects as.
--      GRANT EXECUTE below names it, matching 0425 and 0475.
--   3. CREATE INDEX here is NOT CONCURRENTLY, so it takes a lock for the duration of the
--      build. build.roadmap_items is small on every measured tenant; if that stops being
--      true, split the two index statements into a CONCURRENTLY bundle with an
--      out-of-transaction runner the way hr-audit-cursor/0400 needs, because
--      drizzle-kit migrate wraps this file in one transaction.
--   4. Phase 1 should confirm the number 1175 is still free when it is registered; the
--      applied set reached 1174 when this was written.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_roadmap_items_title_trgm
  ON build.roadmap_items USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_roadmap_items_description_trgm
  ON build.roadmap_items USING gin (description gin_trgm_ops)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_roadmap_item_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, build, app
AS $$
  SELECT r.id
  FROM build.roadmap_items r
  WHERE r.org_id = app.current_org_id()
    AND r.deleted_at IS NULL
    AND (r.title ILIKE '%' || p_q || '%' OR r.description ILIKE '%' || p_q || '%')
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_roadmap_item_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_roadmap_item_ids(text, integer) TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE
  body text;
  secdef boolean;
BEGIN
  SELECT p.prosrc, p.prosecdef INTO body, secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'search_roadmap_item_ids';
  IF body IS NULL THEN
    RAISE EXCEPTION '1175: app.search_roadmap_item_ids() is absent after creation';
  END IF;
  IF NOT secdef THEN
    RAISE EXCEPTION '1175: the probe is not SECURITY DEFINER, so it stays inside the RLS barrier and indexes nothing';
  END IF;
  IF body NOT LIKE '%app.current_org_id()%' THEN
    RAISE EXCEPTION '1175: the probe does not scope to app.current_org_id(), so it would read across tenants';
  END IF;
  IF body LIKE '%p_org%' THEN
    RAISE EXCEPTION '1175: the probe takes the org as a parameter, which fails open instead of 42501';
  END IF;
  IF body NOT LIKE '%LIMIT p_limit%' THEN
    RAISE EXCEPTION '1175: the probe is unbounded, which is slower than the seq scan for a broad term';
  END IF;
END
$$;
