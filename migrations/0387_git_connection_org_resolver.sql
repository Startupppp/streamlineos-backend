SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0387 — resolve the org id for an inbound git webhook, same shape as 0385/0386.
--
-- POST /integrations/git/webhook identifies the connection by `?connectionId=`,
-- a serial (guessable) id — the real security boundary is the HMAC/token
-- signature verified against `git_connections.webhook_secret` AFTER this
-- lookup, not the id itself. 0378 put git_connections behind
-- `org_id = app.current_org_id()`, so the lookup that finds which secret to
-- verify against now 42501s.
--
-- A `git_connections` policy arm keyed on `id` would grant blanket read access
-- to the FULL row — including `webhook_secret` — to any future or existing
-- unguarded `id`-only query against this table, not just this one webhook
-- handler. The SECURITY DEFINER resolver keeps the fix scoped to the one
-- column this lookup actually needs to proceed.

CREATE OR REPLACE FUNCTION app.resolve_git_connection_org_id(p_connection_id integer) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM git_connections WHERE id = p_connection_id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_git_connection_org_id(integer) IS
  'Returns only the org_id for a git connection, bypassing RLS for that single column so an inbound webhook can resolve its tenant before verifying the request signature. Never expose any other connection column (esp. webhook_secret) through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_git_connection_org_id(integer) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_git_connection_org_id(integer) TO %I', app_role);
  END IF;
END $$;
