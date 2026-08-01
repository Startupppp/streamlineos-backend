SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0381 — make context-less READS of platform-global rows deterministic.
--
-- 0380 repaired the WRITE side by mirroring the nullable-aware CASE into
-- WITH CHECK, which is why sign-in (email_outbox with a NULL organization_id)
-- and the auth audit trail record again. It did not fix the READ side, and the
-- reason is subtle enough to be worth writing down.
--
-- An RLS USING predicate is evaluated PER ROW over the rows a scan touches, and
-- it is applied before the query's own WHERE. So with
--   USING (CASE WHEN org_id IS NULL THEN true ELSE org_id = app.current_org_id() END)
-- a statement running outside a tenant transaction survives only for as long as
-- every row it happens to touch is platform-global. The first tenant-owned row
-- in the scan reaches the ELSE arm, app.current_org_id() raises 42501, and the
-- whole statement aborts — even for a query that asked only for the global rows.
--
-- That makes the behaviour a function of table contents and of the plan chosen,
-- not of the code. Verified against the live DB on 2026-08-01, as streamline_app
-- with no tenant context: reading notification_events succeeded while reading
-- audit_logs failed 42501, purely because audit_logs already holds tenant rows.
-- The notification-event catalog seed is passing today for that reason alone and
-- would start failing again the first time any org writes an event override.
--
-- Fix: the read side uses a non-raising accessor, so a tenant-owned row simply
-- fails the predicate and is filtered out rather than aborting the statement. A
-- context-less reader therefore sees platform-global rows and nothing else,
-- which is the guarantee the nullable branch was written to express. This is a
-- narrowing of tenant visibility, never a widening — no cross-tenant row becomes
-- readable, because org_id = NULL is NULL and NULL is not TRUE.
--
-- WITH CHECK deliberately KEEPS the raising accessor. A write is a single known
-- row, so there is no scan to abort: a global row (NULL tenant) is accepted from
-- anywhere, and a tenant-owned row written outside a tenant transaction still
-- fails loudly with 'no tenant context' instead of the generic RLS violation.
-- Reads degrade to a filter; writes stay fail-fast. Tables whose tenant column
-- is NOT NULL are untouched and keep raising on both sides.
--
-- Driven from pg_policy so it covers every table currently carrying
-- tenant_isolation regardless of which batch created it. Re-running is a no-op.

CREATE OR REPLACE FUNCTION app.current_org_id_or_null() RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN nullif(current_setting('app.organization_id', true), '');
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.current_org_id_or_null() IS
  'Tenant id for the current transaction, or NULL when unset. Read-side companion to app.current_org_id(). Never raises, so a scan that crosses a tenant-owned row outside a tenant transaction filters that row out instead of aborting the statement. Use in USING only; WITH CHECK keeps app.current_org_id() so unplumbed writes still fail loudly.';
--> statement-breakpoint

-- The application role is provisioned per environment by `pnpm db:bootstrap-role`,
-- so grant only if it already exists. Mirrors 0374.
DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id_or_null() TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  target record;
  using_expr text;
  check_expr text;
  applied int := 0;
BEGIN
  FOR target IN
    SELECT DISTINCT ON (c.oid)
      c.relname AS table_name,
      a.attname AS tenant_column
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname IN ('org_id', 'organization_id')
      AND format_type(a.atttypid, NULL) = 'text'
      AND NOT a.attnotnull
    ORDER BY c.oid, (a.attname = 'org_id') DESC
  LOOP
    using_expr := format(
      'CASE WHEN %I IS NULL THEN true ELSE %I = app.current_org_id_or_null() END',
      target.tenant_column, target.tenant_column
    );
    check_expr := format(
      'CASE WHEN %I IS NULL THEN true ELSE %I = app.current_org_id() END',
      target.tenant_column, target.tenant_column
    );

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      target.table_name, using_expr, check_expr
    );
    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'tenant_isolation read predicate relaxed on % nullable-tenant table(s)', applied;
END $$;
