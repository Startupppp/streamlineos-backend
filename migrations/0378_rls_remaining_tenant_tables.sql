SET statement_timeout = 0;

-- 0378 — RLS batch 3: every remaining tenant-scoped table.
-- Deliberately unfiltered. Batches 1 and 2 select by name prefix, which orders a
-- rollout but must never be relied on for completeness — a table matching no
-- prefix would stay unprotected and nothing would report it. Defined by what is
-- LEFT, so new tables are covered the next time this shape is applied.

DO $$
DECLARE
  target record;
  using_expr text;
  applied int := 0;
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
    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'tenant_isolation applied to % remaining table(s)', applied;
END $$;
