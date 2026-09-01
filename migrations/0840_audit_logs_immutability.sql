SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.nullify_audit_logs_org_id(p_org_id text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  UPDATE public.audit_logs
  SET org_id = NULL
  WHERE org_id = p_org_id
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.nullify_audit_logs_org_id(text) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.nullify_audit_logs_org_id(text) TO streamline_app;
--> statement-breakpoint

REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM streamline_app;
