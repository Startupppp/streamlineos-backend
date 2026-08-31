-- 0803: GIN trigram indexes + SECURITY DEFINER search function for organization_people.
--
-- Leading-wildcard ILIKE on organization_people.first_name / last_name / display_name /
-- work_email forces a full-tenant scan because search operators are proleakproof=false.
-- Even without RLS, this is a table-wide scan on every directory search call.
-- ALTER FUNCTION ... LEAKPROOF is impossible on Neon (42501 even as neondb_owner).
--
-- Escape: SECURITY DEFINER function owned by the BYPASSRLS role runs outside any
-- security barrier. Same five safety conditions as app.search_ticket_ids (0424/0425)
-- and app.search_hr_person_ids (0689):
--   1. org from app.current_org_id() — never a parameter (fails closed 42501 with no GUC)
--   2. returns organization_person_id (text UUIDs) ONLY — no row data
--   3. caller query still runs with its own tenant predicate
--   4. REVOKE ALL FROM PUBLIC + GRANT EXECUTE to the app role
--   5. LIMIT argument: caller requests cap+1; falls back to ILIKE at the cap so
--      the SRF is never fully materialised for very broad terms

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_people_first_name_trgm"
  ON "organization_people" USING gin ("first_name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_people_last_name_trgm"
  ON "organization_people" USING gin ("last_name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_people_display_name_trgm"
  ON "organization_people" USING gin ("display_name" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_people_work_email_trgm"
  ON "organization_people" USING gin ("work_email" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_organization_people_ids(p_q text, p_limit integer)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT organization_person_id
  FROM public.organization_people
  WHERE organization_id = app.current_org_id()
    AND deleted_at IS NULL
    AND (
      first_name    ILIKE '%' || p_q || '%'
      OR last_name  ILIKE '%' || p_q || '%'
      OR display_name ILIKE '%' || p_q || '%'
      OR work_email ILIKE '%' || p_q || '%'
    )
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_organization_people_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_organization_people_ids(text, integer) TO streamline_app;
