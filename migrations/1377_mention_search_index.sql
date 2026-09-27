SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE tablename = 'users' AND schemaname = 'public'
  ) THEN
    RAISE EXCEPTION '1377 precondition: public.users is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND schemaname = 'public'
      AND indexname = 'idx_users_email_trgm'
  ) THEN
    RAISE EXCEPTION '1377 precondition: idx_users_email_trgm is absent (expected from 0007)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND schemaname = 'public'
      AND indexname = 'idx_users_name_trgm'
  ) THEN
    RAISE EXCEPTION '1377 precondition: idx_users_name_trgm is absent (expected from 0007)';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_mention_user_ids(p_tokens text[])
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT DISTINCT u.id
  FROM public.organization_members om
  JOIN public.users u ON u.id = om.user_id,
       unnest(p_tokens) AS t(tok)
  WHERE om.org_id = app.current_org_id()
    AND (
      u.email ILIKE '%' || t.tok || '%'
      OR u.name ILIKE '%' || t.tok || '%'
    )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_mention_user_ids(text[]) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_mention_user_ids(text[]) TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'app' AND p.proname = 'search_mention_user_ids'
  ), '1377 post-check: app.search_mention_user_ids was not created';
END $$;
