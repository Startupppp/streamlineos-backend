-- Revert 1069: remove the append-only trigger from the break-glass access trail
-- and restore the application role's mutation grants. Run only during an
-- approved rollback; this temporarily removes the database-level mutation guard
-- on the one record that a platform operator entered a customer tenant, and must
-- be followed by the release authority's compensating control.
--
-- The redaction function is left in place: it is harmless without the trigger and
-- dropping it would break any erasure path already calling it.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS operator_access_log_append_only ON public.operator_access_log;
--> statement-breakpoint

GRANT UPDATE, DELETE ON TABLE public.operator_access_log TO streamline_app;
