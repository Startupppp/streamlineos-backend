-- Reverses 1087. Removes the `control_plane_access` policy from the five
-- cell/placement/relocation tables, restoring `tenant_isolation` on any of them
-- where row security is actually enforced.
--
-- THE FIVE ARE NOT IN THE SAME STATE, which is why this file is not a flat list
-- of DROPs. On a chain-built database four of them — placement_decisions,
-- organization_relocations, organization_relocation_checksums and
-- noisy_neighbour_reviews — have row security DISABLED, so their policy is inert
-- and dropping it changes nothing anyone can observe. `organization_cell_traffic`
-- has row security ENABLED and `control_plane_access` is its ONLY policy, so a
-- bare DROP there would deny every row to every non-owner role: the table would
-- stop answering rather than answer too narrowly. That asymmetry is real and was
-- read out of pg_class rather than assumed, so this rollback branches on it.
--
-- WHERE THE RESTORED TEXT COMES FROM. The chain never spells these policies out
-- per table: 0378 is a catalog sweep over every public table carrying a text
-- `org_id`/`organization_id` and no RLS yet, so it names no table and a grep for
-- these five finds nothing. Every tenant column below is NOT NULL, which selects
-- the sweep's `tenant_required` branch:
--
--   CREATE POLICY tenant_isolation ON public.<t> FOR ALL
--     USING (<col> = app.current_org_id())
--     WITH CHECK (<col> = app.current_org_id())
--
-- which is also what 1087's own header describes it as replacing ("every one of
-- these tables used app.current_org_id(), the throwing variant").
--
-- ⚠ RESTORING IT RESTORES THE BREAKAGE. Where this file puts `tenant_isolation`
-- back, the throwing variant returns with it: these rows are written by platform
-- paths that hold no app.organization_id, so they raise 42501 again. That is the
-- prior state, and a rollback restores the state before the migration without
-- promising it was good — the reason 1087 exists is that it was not.
--
-- Where row security is disabled, no policy is written at all: inventing a
-- `tenant_isolation` the chain never contained would be creating DDL rather than
-- reversing it, the same gap the 1082 and 1085 rollbacks name.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$
DECLARE
  target record;
  rls_on boolean;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('placement_decisions',               'organization_id'),
      ('organization_relocations',          'organization_id'),
      ('organization_relocation_checksums', 'org_id'),
      ('organization_cell_traffic',         'org_id'),
      ('noisy_neighbour_reviews',           'organization_id')
    ) AS t(table_name, tenant_column)
  LOOP
    SELECT c.relrowsecurity INTO rls_on
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = target.table_name;

    IF NOT FOUND THEN
      RAISE NOTICE 'Rollback 1087: % does not exist; skipping.', target.table_name;
      CONTINUE;
    END IF;

    -- Only where the policy is actually enforced does the table need one to be
    -- left with. The whole DO block is one statement, so the drop and the create
    -- commit together: the table is never RLS-enabled and policy-less to any
    -- other session. The leading DROP is idempotency, not sequencing — re-running
    -- this file would otherwise raise 42710 on the second pass.
    IF rls_on THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.table_name);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL '
        'USING (%I = app.current_org_id()) WITH CHECK (%I = app.current_org_id())',
        target.table_name, target.tenant_column, target.tenant_column
      );
      RAISE NOTICE
        'Rollback 1087: restored tenant_isolation on % — the throwing predicate is back, '
        'so out-of-tenant control-plane writes to it will raise 42501 again.',
        target.table_name;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS control_plane_access ON public.%I', target.table_name);
  END LOOP;
END
$rollback$;
