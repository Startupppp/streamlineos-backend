-- 0801 created calendar_actor_migration_report to record cross-tenant and orphaned
-- attendees found during the calendar actor cutover. It found none: the table has 0 rows,
-- no application code reads it, and 0819 revoked every app-role privilege on it.
--
-- It is dropped rather than exempted. Its nullable org_id makes a tenant_isolation policy
-- meaningless, so keeping it would have required adding it to PLATFORM_GLOBAL_TABLES —
-- the single list that can silence a real cross-tenant hole, pinned by
-- test/security/rls-exemption-allowlist.spec.ts. Removing the table removes the exemption.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  remaining bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'calendar_actor_migration_report'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.calendar_actor_migration_report' INTO remaining;
    IF remaining > 0 THEN
      RAISE EXCEPTION '0829: calendar_actor_migration_report holds % row(s); it recorded real cutover findings and must be reviewed before being dropped', remaining;
    END IF;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS public.calendar_actor_migration_report;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'calendar_actor_migration_report'
  ) THEN
    RAISE EXCEPTION '0829: calendar_actor_migration_report still exists';
  END IF;
END $$;
