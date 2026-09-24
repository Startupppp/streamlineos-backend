-- Rollback for 1112_operator_access_log_restore_append_only_privileges.
--
-- The forward migration made operator_access_log append-only by revoking
-- UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER from streamline_app.
-- This rollback re-grants exactly those same privileges to that role.
--
-- SECURITY CONSEQUENCE: Applying this rollback removes the append-only guard
-- on the audit log. The application role regains the ability to modify or
-- delete existing audit rows, undermining audit log integrity. This is an
-- emergency-only operation; re-apply 1112 as soon as the underlying issue
-- is resolved.

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.operator_access_log') IS NOT NULL THEN
    EXECUTE 'GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.operator_access_log TO streamline_app';
  END IF;
END $$;
