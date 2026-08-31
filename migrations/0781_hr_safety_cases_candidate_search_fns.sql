-- 0781: SECURITY DEFINER search functions + trgm indexes for hr_safety_incidents,
-- hr_cases and candidates.
--
-- Leading-wildcard ILIKE on these tables cannot use a pg_trgm index under RLS:
-- search operators are proleakproof=false, so the security qual runs first and the
-- index is skipped (full tenant scan). LEAKPROOF is impossible on Neon (42501).
-- Escape: SECURITY DEFINER function owned by the BYPASSRLS owner (same as
-- app.search_ticket_ids 0424/0425 and app.search_hr_person_ids 0689).
--
-- Safety conditions on every function:
--   1. org from app.current_org_id() — never a parameter (fails closed 42501 with no GUC)
--   2. returns integer ids ONLY — no row data
--   3. caller query still runs under RLS with its DataScope clause
--   4. REVOKE ALL FROM PUBLIC + GRANT EXECUTE to the app role
--   5. LIMIT argument — caller requests cap+1; falls back to ILIKE past the cap so
--      the SRF is never fully materialised

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_safety_incidents_description_trgm"
  ON "hr_safety_incidents" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_safety_incidents_location_trgm"
  ON "hr_safety_incidents" USING gin ("location" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_safety_incident_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.hr_safety_incidents
  WHERE org_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      description   ILIKE '%' || p_q || '%'
      OR incident_number ILIKE '%' || p_q || '%'
      OR location   ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_safety_incident_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_safety_incident_ids(text, integer) TO streamline_app;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_cases_summary_trgm"
  ON "hr_cases" USING gin ("summary" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_case_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.hr_cases
  WHERE org_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      summary     ILIKE '%' || p_q || '%'
      OR case_number ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_case_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_case_ids(text, integer) TO streamline_app;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_candidates_first_name_trgm"
  ON "candidates" USING gin ("first_name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_candidates_last_name_trgm"
  ON "candidates" USING gin ("last_name" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_candidate_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT id
  FROM public.candidates
  WHERE org_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      first_name      ILIKE '%' || p_q || '%'
      OR last_name    ILIKE '%' || p_q || '%'
      OR email        ILIKE '%' || p_q || '%'
      OR current_company ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_candidate_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_candidate_ids(text, integer) TO streamline_app;
