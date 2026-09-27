-- 1377: replace @mention leading-wildcard ILIKE with a SECURITY DEFINER index search.
--
-- processCommentMentions resolved mentions with OR(ilike(users.email, '%tok%'), ilike(users.name, '%tok%'))
-- over an organization_members/users join. That pattern violates BE-49: the `textlike` operator is
-- not leakproof, so under the organization_members RLS security barrier the planner cannot evaluate
-- the predicate before the security qual and skips the GIN indexes on users.email and users.name
-- entirely, falling back to a sequential scan of all org members.
--
-- `users` itself has no org_id column and no RLS policy, so a direct GIN trigram index on users is
-- reachable when queried alone. However, the mention query joins through organization_members (which
-- HAS RLS), and that join's security barrier prevents the planner from pushing the ILIKE past the
-- barrier to access the GIN index on users. The 0275 migration documents the same pattern for
-- business_parties.
--
-- The GIN trigram indexes idx_users_email_trgm and idx_users_name_trgm already exist from migration
-- 0007. The pg_trgm extension is already installed. This migration only adds the SECURITY DEFINER
-- function that provides a guaranteed index path: inside SECURITY DEFINER (BYPASSRLS) neither the
-- organization_members RLS barrier nor any security qual applies, so both GIN indexes are reachable.
--
-- Org scope comes from app.current_org_id() (the per-connection GUC), never from a parameter, so
-- the function fails closed with 42501 when no GUC is set. It returns ids only and no row data.
-- The caller's own Drizzle query still runs under RLS with eq(organizationMembers.orgId, orgId).
-- EXECUTE is revoked from PUBLIC.
--
-- Not CONCURRENTLY: db:migrate runs each statement in a transaction where CONCURRENTLY is not
-- allowed. lock_timeout handles the lock-wait scenario instead.

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
