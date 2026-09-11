SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 1057 — resolve the org id for an inbound calendar provider webhook.
--
-- Same shape, and the same reason, as 0385/0386/0387.
--
-- POST /webhooks/calendar/provider is @Public(): a Google or Outlook change
-- notification carries no session, so TenantContextInterceptor opens no tenant
-- transaction and `createTenantAwareDb` falls through to the raw pool with
-- `app.organization_id` unset. `user_integration_connections` is behind
-- `org_id = app.current_org_id()`, and that function RAISES 42501 when the GUC is
-- unset rather than returning NULL — so the lookup that decides WHICH TENANT the
-- delivery belongs to could not run at all, and every well-formed, correctly
-- secreted delivery answered HTTP 500. The provider retried, got 500 again, and
-- the drift-reconciliation half of PRD-C129 never executed for any tenant.
--
-- Widening the table's own policy with an `id`-keyed arm was rejected for the
-- reason 0387's header already states: a policy arm grants read of the FULL row
-- to every existing and future id-only query against this table, and this table
-- holds `composio_connected_account_id` — the bearer of the OAuth grant. The
-- SECURITY DEFINER resolver keeps the bypass to the single column the tenant
-- lookup actually needs. The connection row itself is re-read by the caller
-- inside `runInNewTenantTransaction(orgId, …)`, under live RLS, where the
-- status = 'active' and calendar-toolkit predicate is enforced.

CREATE OR REPLACE FUNCTION app.resolve_calendar_connection_org_id(p_connection_id integer) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM user_integration_connections WHERE id = p_connection_id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_calendar_connection_org_id(integer) IS
  'Returns only the org_id for a user integration connection, bypassing RLS for that single column so an inbound calendar provider webhook can resolve its tenant before it holds one. Never expose any other column through this path (esp. composio_connected_account_id); the connection row is re-read under RLS inside the tenant transaction.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_calendar_connection_org_id(integer) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_calendar_connection_org_id(integer) TO %I', app_role);
  END IF;
END $$;
