-- 0930: enforce append-only audit logs at the database boundary.
-- The purge detachment function is the only supported UPDATE path; it marks
-- its transaction with a private local setting after validating tenant scope.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.audit_log_detachment', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.prevent_audit_log_mutation() FROM PUBLIC;
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

  PERFORM set_config('app.audit_log_detachment', 'true', true);

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

DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
--> statement-breakpoint

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION app.prevent_audit_log_mutation();
