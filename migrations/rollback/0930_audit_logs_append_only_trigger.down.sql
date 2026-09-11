-- Revert 0930: remove the append-only trigger and restore the 0928 detachment
-- function shape. Run only during an approved rollback; this temporarily
-- removes the database-level mutation guard and must be followed by the
-- release authority's compensating control.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
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
