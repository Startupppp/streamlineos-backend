SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0380 — repair tenant_isolation WITH CHECK on nullable tenant columns.
--
-- 0376, 0377 and 0378 each computed a nullable-aware USING expression and then
-- ignored it when building the policy, hardcoding
--   WITH CHECK (<tenant_col> = app.current_org_id())
-- That calls the raising helper from 0374 on EVERY write. Two consequences:
--
--   1. Any INSERT/UPDATE issued outside a tenant transaction fails 42501, even
--      when the row is deliberately platform-level. The sign-in OTP path writes
--      email_outbox with organization_id NULL before any org context exists, so
--      no sign-in email could be queued and sign-in was broken.
--   2. Inside a valid tenant transaction a NULL-tenant row is still rejected,
--      because NULL = '<org>' evaluates to NULL and WITH CHECK passes on TRUE
--      only.
--
-- WITH CHECK now mirrors USING. CASE is used rather than `IS NULL OR ...`
-- because Postgres guarantees a CASE will not evaluate an arm it does not need,
-- which keeps app.current_org_id() unevaluated when the tenant column is NULL.
-- Relying on OR short-circuiting around a function that raises is not a
-- guarantee worth depending on.
--
-- Tables whose tenant column is NOT NULL keep exactly the predicate they had.
-- Driven from pg_policy so every table currently carrying tenant_isolation is
-- repaired regardless of which batch created it, and re-running is a no-op.

DO $$
DECLARE
  target record;
  predicate text;
  applied int := 0;
BEGIN
  FOR target IN
    SELECT DISTINCT ON (c.oid)
      c.relname AS table_name,
      a.attname AS tenant_column,
      a.attnotnull AS tenant_required
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname IN ('org_id', 'organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
    ORDER BY c.oid, (a.attname = 'org_id') DESC
  LOOP
    IF target.tenant_required THEN
      predicate := format('%I = app.current_org_id()', target.tenant_column);
    ELSE
      predicate := format(
        'CASE WHEN %I IS NULL THEN true ELSE %I = app.current_org_id() END',
        target.tenant_column, target.tenant_column
      );
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      target.table_name, predicate, predicate
    );
    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'tenant_isolation repaired on % table(s)', applied;
END $$;
