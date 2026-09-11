-- 1069: make the break-glass access trail append-only at the database boundary.
--
-- operator_access_log records who opened break-glass access to a customer tenant,
-- when, from where, and under which grant. It is the only record that a platform
-- operator entered a tenant. The application role could UPDATE and DELETE it, so
-- the one actor with a motive to edit the trail was the one able to.
--
-- Mirrors 0928/0930 for audit_logs: revoke the mutation grants, then enforce the
-- same rule with a trigger so a future ALTER DEFAULT PRIVILEGES cannot silently
-- restore them. Erasure redacts through the SECURITY DEFINER function below
-- rather than deleting -- the row survives, the operator's IP and free-form
-- detail do not.

SET lock_timeout = '5s';
--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.operator_access_log FROM streamline_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.prevent_operator_access_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.operator_access_log_redaction', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'operator_access_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.prevent_operator_access_log_mutation() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.redact_operator_access_log_subject(p_operator_user_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF p_operator_user_id IS NULL
     OR current_setting('app.organization_id', true) IS NULL THEN
    RAISE EXCEPTION 'operator access log redaction requires the current tenant context';
  END IF;

  PERFORM set_config('app.operator_access_log_redaction', 'true', true);

  UPDATE public.operator_access_log
  SET ip_address = NULL,
      detail = NULL
  WHERE operator_user_id = p_operator_user_id
    AND org_id = current_setting('app.organization_id', true);

  PERFORM set_config('app.operator_access_log_redaction', 'false', true);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.redact_operator_access_log_subject(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.redact_operator_access_log_subject(text) TO streamline_app;
--> statement-breakpoint

DROP TRIGGER IF EXISTS operator_access_log_append_only ON public.operator_access_log;
--> statement-breakpoint

CREATE TRIGGER operator_access_log_append_only
BEFORE UPDATE OR DELETE ON public.operator_access_log
FOR EACH ROW EXECUTE FUNCTION app.prevent_operator_access_log_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS operator_access_log_no_truncate ON public.operator_access_log;
--> statement-breakpoint

-- A row-level trigger never fires on TRUNCATE, so the row-level guard above would
-- have let one statement empty the whole trail. Measured, not assumed: TRUNCATE
-- succeeded against the row-level trigger alone in a rolled-back rehearsal.
CREATE TRIGGER operator_access_log_no_truncate
BEFORE TRUNCATE ON public.operator_access_log
FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_operator_access_log_mutation();
