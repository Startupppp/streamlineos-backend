-- 0689: index-backed HR person search under RLS.
--
-- Leading-wildcard ILIKE on organization_people.first_name / last_name / work_email
-- cannot use a pg_trgm index under RLS: search operators are proleakproof=false, so the
-- security qual runs first and the index is skipped (seq scan for every search call).
-- ALTER FUNCTION ... LEAKPROOF is impossible on Neon (no true superuser, 42501 even in console).
--
-- Escape: a SECURITY DEFINER function owned by the BYPASSRLS owner runs outside the security
-- barrier. Safety rests on five conditions (same as app.search_ticket_ids, 0424/0425):
--   1. org always from app.current_org_id() — never a parameter (fails closed 42501 with no GUC)
--   2. returns hr_people integer ids ONLY — never row data
--   3. caller's query still runs under RLS with its DataScope clause
--   4. REVOKE ALL FROM PUBLIC + GRANT EXECUTE to the app role
--   5. LIMIT argument: caller requests cap+1 and falls back to ILIKE at the cap so an
--      unbounded SRF is never fully materialised
--
-- This is the highest-value HR case: the main employee list is searched by name and work
-- email on every admin directory page. The organization_people table is joined to hr_people
-- so the function returns the integer hr_people.id used by the list cursor.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_hr_person_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT hp.id
  FROM public.hr_people hp
  INNER JOIN public.organization_people op
    ON op.organization_id = hp.org_id
   AND op.organization_person_id = hp.organization_person_id
  WHERE hp.org_id = app.current_org_id()
    AND hp.deleted_at IS NULL
    AND (
      op.first_name ILIKE '%' || p_q || '%'
      OR op.last_name  ILIKE '%' || p_q || '%'
      OR op.work_email ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_hr_person_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_hr_person_ids(text, integer) TO streamline_app;
