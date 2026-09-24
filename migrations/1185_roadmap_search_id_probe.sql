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
    RAISE EXCEPTION '1177: app.search_roadmap_item_ids() is absent after creation';
  END IF;
  IF NOT secdef THEN
    RAISE EXCEPTION '1177: the probe is not SECURITY DEFINER, so it stays inside the RLS barrier and indexes nothing';
  END IF;
  IF body NOT LIKE '%app.current_org_id()%' THEN
    RAISE EXCEPTION '1177: the probe does not scope to app.current_org_id(), so it would read across tenants';
  END IF;
  IF body LIKE '%p_org%' THEN
    RAISE EXCEPTION '1177: the probe takes the org as a parameter, which fails open instead of 42501';
  END IF;
  IF body NOT LIKE '%LIMIT p_limit%' THEN
    RAISE EXCEPTION '1177: the probe is unbounded, which is slower than the seq scan for a broad term';
  END IF;
END
$$;
