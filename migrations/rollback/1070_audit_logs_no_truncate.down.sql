-- Revert 1070: remove the TRUNCATE guard from audit_logs.
--
-- Run only during an approved rollback. This reinstates the hole 1070 closed: the
-- remaining row-level trigger cannot see TRUNCATE, so a single statement run as the
-- owner empties the audit log with no error.
-- Must be followed by the release authority's compensating control.
--
-- The guard function is left in place -- the row-level trigger from 0930 still uses it.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
