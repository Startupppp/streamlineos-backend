SET statement_timeout = 0;

-- 0377 — RLS batch 2: money. Same catalog-driven shape as 0376.

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
        c.relname LIKE 'acct%' OR
        c.relname LIKE 'accounting%' OR
        c.relname LIKE 'invoice%' OR
        c.relname LIKE 'billing%' OR
        c.relname LIKE 'payment%' OR
        c.relname LIKE 'subscription%' OR
        c.relname LIKE 'expense%' OR
        c.relname LIKE 'purchase%' OR
        c.relname LIKE 'journal%' OR
        c.relname LIKE 'ledger%' OR
        c.relname LIKE 'tax%' OR
        c.relname LIKE 'coupon%' OR
        c.relname LIKE 'credit%' OR
        c.relname LIKE 'ai_credit%' OR
        c.relname LIKE 'ai_usage%' OR
        c.relname LIKE 'wallet%' OR
        c.relname LIKE 'quote%' OR
        c.relname LIKE 'bank%' OR
        c.relname LIKE 'budget%'
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
