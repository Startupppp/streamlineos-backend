-- Reverses 1085. Removes the `control_plane_access` policy from the three
-- organisation-lifecycle tables: organization_lifecycle_sagas,
-- organization_saga_steps and organization_reservations.
--
-- SAME ASYMMETRY AS THE 1082 ROLLBACK, and for the same reason. 1085 is a
-- `DROP POLICY IF EXISTS "tenant_isolation"` followed by a CREATE on each table.
-- This file reverses the CREATEs exactly and does NOT recreate
-- `tenant_isolation`: no migration in this chain ever created it on any of the
-- three, so there is no recorded text to restore and writing one would mean
-- inventing DDL rather than reversing any. The throwing-variant policy 1085's
-- header describes existed only on databases a catalog sweep had reached out of
-- band.
--
-- ALL THREE HAVE ROW SECURITY DISABLED on a chain-built database, so a table
-- left with no policy is not a table that denies everything. That is checked
-- per table below rather than assumed, because dropping the only policy on an
-- RLS-ENABLED table locks every non-owner role out of it — which for these three
-- means organisation creation stops entirely, a worse outcome than the 42501
-- that 1085 fixed.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$
DECLARE
  target text;
  rls_on boolean;
  other_policies bigint;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'organization_lifecycle_sagas',
    'organization_saga_steps',
    'organization_reservations'
  ] LOOP
    SELECT c.relrowsecurity INTO rls_on
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = target;

    IF NOT FOUND THEN
      RAISE NOTICE 'Rollback 1085: % does not exist; skipping.', target;
      CONTINUE;
    END IF;

    SELECT count(*) INTO other_policies
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = target
       AND p.polname <> 'control_plane_access';

    IF rls_on AND other_policies = 0 THEN
      RAISE EXCEPTION
        'Refusing to roll back 1085: row security is ENABLED on % and control_plane_access is '
        'its only policy. Dropping it would deny every row to every non-owner role and stop '
        'organisation creation outright. Install the policy this database is meant to carry '
        'first, then re-run this rollback.', target;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'control_plane_access', target);
  END LOOP;
END
$rollback$;
