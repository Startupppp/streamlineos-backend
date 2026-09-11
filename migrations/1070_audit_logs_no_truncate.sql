-- 1070: close the TRUNCATE hole in the audit-log append-only guard.
--
-- 0930 created `audit_logs_append_only` as BEFORE UPDATE OR DELETE ... FOR EACH ROW.
-- A row-level trigger never fires on TRUNCATE, which is a statement-level operation,
-- so one `TRUNCATE public.audit_logs` emptied an append-only audit log without the
-- guard raising. Measured on the deployed database before this migration: the
-- trigger's tgtype carried the UPDATE and DELETE bits and not the TRUNCATE one.
--
-- 0928's REVOKE covers streamline_app, and TRUNCATE is owner-only by default, so the
-- application role was already blocked. The exposure is every path that runs as the
-- owner -- migrations and maintenance scripts -- which is where an audit log gets
-- wiped by accident rather than by attack.
--
-- No new function. `app.prevent_audit_log_mutation()` returns early only for an UPDATE
-- carrying the detachment flag; TRUNCATE reaches the RAISE unchanged.
--
-- audit_logs is an ordinary table here, not partitioned (relkind 'r', zero children),
-- so one statement-level trigger covers it completely. Were it ever partitioned, a
-- TRUNCATE issued against a child partition would bypass a parent-only trigger.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON public.audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_audit_log_mutation();
