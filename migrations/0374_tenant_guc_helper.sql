SET statement_timeout = 0;

-- 0374 — tenant GUC accessor for RLS policies.
-- Policies call this instead of current_setting() because current_setting does
-- NOT reliably raise on an unset GUC: once a custom parameter has been set once
-- in a session it stays known and afterwards reads as '', so every pooled
-- connection after its first request would deny silently instead of loudly.
-- Replace this one function to change that behaviour; no policy needs editing.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  value text;
BEGIN
  value := nullif(current_setting('app.organization_id', true), '');
  IF value IS NULL THEN
    RAISE EXCEPTION 'no tenant context: app.organization_id is not set for this transaction'
      USING ERRCODE = '42501';
  END IF;
  RETURN value;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.current_org_id() IS
  'Tenant id for the current transaction. Raises 42501 when unset so an unplumbed query fails loudly instead of returning nothing.';
--> statement-breakpoint

-- The application role is provisioned per environment by `pnpm db:bootstrap-role`,
-- so grant only if it already exists; the script grants this schema too.
DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id() TO %I', app_role);
  END IF;
END $$;
