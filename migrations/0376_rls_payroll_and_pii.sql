SET statement_timeout = 0;

-- 0376 — RLS batch 1: payroll, HR and PII.
-- Driven from pg_catalog, not a hand-written table list: a list goes stale the
-- moment a migration adds a table, and the missing table is silently
-- unprotected. Nullable org_id tables also admit NULL rows on READ but never on
-- WRITE, because eight tables hold genuinely global rows that payroll and
-- notifications depend on. Inert until APP_DATABASE_URL is set.

DO $$
DECLARE
  target record;
  using_expr text;
BEGIN
  FOR target IN
    SELECT DISTINCT ON (c.oid)
      c.relname AS table_name,
      a.attname AS tenant_column,
      a.attnotnull AS tenant_required
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
      AND a.attname IN ('org_id', 'organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
      AND (
        c.relname LIKE 'payroll%' OR
        c.relname LIKE 'hr%' OR
        c.relname LIKE 'employee%' OR
        c.relname LIKE 'salary%' OR
        c.relname LIKE 'attendance%' OR
        c.relname LIKE 'leave%' OR
        c.relname LIKE 'shift%' OR
        c.relname LIKE 'timesheet%' OR
        c.relname LIKE 'reimbursement%' OR
        c.relname LIKE 'termination%' OR
        c.relname LIKE 'onboarding%' OR
        c.relname LIKE 'offboarding%' OR
        c.relname LIKE 'recruitment%' OR
        c.relname LIKE 'candidate%' OR
        c.relname LIKE 'applicant%' OR
        c.relname LIKE 'interview%' OR
        c.relname LIKE 'performance%' OR
        c.relname LIKE 'background_verification%' OR
        c.relname LIKE 'org_unit%' OR
        c.relname LIKE 'audit_log%' OR
        c.relname LIKE 'login_history%' OR
        c.relname LIKE 'user_%'
      )
    ORDER BY c.oid, (a.attname = 'org_id') DESC
  LOOP
    IF target.tenant_required THEN
      using_expr := format('%I = app.current_org_id()', target.tenant_column);
    ELSE
      using_expr := format(
        '%I IS NULL OR %I = app.current_org_id()',
        target.tenant_column, target.tenant_column
      );
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (%s) WITH CHECK (%I = app.current_org_id())',
      target.table_name, using_expr, target.tenant_column
    );
  END LOOP;
END $$;
