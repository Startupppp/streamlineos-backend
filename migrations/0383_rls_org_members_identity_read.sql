SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0383 — let the pre-tenant identity phase read its own memberships.
--
-- Sign-in was failing with 42501 raised from app.current_org_id(). The query:
--
--   select organization_members.org_id, ... from organization_members
--   inner join organizations on organizations.id = organization_members.org_id
--   where organization_members.user_id = $1
--
-- is AuthTokensService.resolveActiveMembership — the step that decides which org
-- the session belongs to. It cannot run inside a tenant transaction, because
-- reading it is how the tenant is chosen. 0378 gave the table the strict
-- predicate `org_id = app.current_org_id()`, so the bootstrap step that must run
-- first became the one step that could not run at all.
--
-- organizations is already excluded from RLS (relrowsecurity = false), as are
-- users/accounts/sessions/user_sessions/email_otp_codes/magic_link_tokens per
-- the rollout plan's global-identity carve-out. organization_members is the one
-- table left straddling the boundary: it is genuinely tenant data, but it is
-- also the identity-to-tenant bridge.
--
-- Rather than excluding it, the policy gains a second, equally strong predicate:
-- a caller may always see their OWN membership rows. `app.user_id` is set only
-- by withIdentity() (src/common/tenant/with-identity.ts) during the pre-tenant
-- phase, and the row must match that principal, so this admits exactly the rows
-- the application's own WHERE clause already asked for.
--
-- Both arms use the NON-raising accessors on purpose. An RLS USING predicate is
-- evaluated per row over everything the scan touches, before the query's own
-- WHERE — so an arm that raises would abort the statement the moment the scan
-- crossed another user's row, which is exactly the failure this migration is
-- fixing. With neither GUC set both arms are NULL, no row qualifies, and the
-- reader sees nothing. Isolation is preserved; only the failure MODE changes,
-- from a raised 42501 to an empty result. Same trade-off as 0381.
--
-- WITH CHECK stays strict and keeps the raising accessor: writing a membership
-- row still demands a real tenant context, so this cannot become a path for a
-- user to insert themselves into an org. Sign-up satisfies that by wrapping its
-- transaction in withTenant() with the org id it just generated.

CREATE OR REPLACE FUNCTION app.current_user_id_or_null() RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN nullif(current_setting('app.user_id', true), '');
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.current_user_id_or_null() IS
  'Authenticated principal for the current transaction, or NULL when unset. Set by withIdentity() during the pre-tenant sign-in phase so a caller can read their own organization_members rows before an org has been chosen. Never raises: an RLS USING arm that raises aborts the whole scan.';
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_user_id_or_null() TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.organization_members;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.organization_members
  FOR ALL
  USING (
    org_id = app.current_org_id_or_null()
    OR user_id = app.current_user_id_or_null()
  )
  WITH CHECK (org_id = app.current_org_id());
