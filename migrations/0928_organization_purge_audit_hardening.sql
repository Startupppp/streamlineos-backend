-- 0928: allow scheduled organization deletion while retaining audit evidence.
-- The application role may invoke this only for its current tenant; it never
-- receives direct UPDATE/DELETE access to the append-only audit table.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.nullify_audit_logs_org_id(p_org_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF p_org_id IS NULL
     OR current_setting('app.organization_id', true) IS NULL
     OR p_org_id <> current_setting('app.organization_id', true) THEN
    RAISE EXCEPTION 'audit-log detachment requires the current tenant context';
  END IF;

  UPDATE public.audit_logs
  SET org_id = NULL,
      actor_membership_id = NULL,
      is_platform_event = true
  WHERE org_id = p_org_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.nullify_audit_logs_org_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.nullify_audit_logs_org_id(text) TO streamline_app;
--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.audit_logs FROM streamline_app;
