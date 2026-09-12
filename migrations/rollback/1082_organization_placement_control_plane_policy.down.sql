-- Reverses 1082. Removes the `control_plane_access` policy from
-- `organization_placement`.
--
-- ONE ASYMMETRY, stated because it cannot be fixed here. 1082 is
-- `DROP POLICY IF EXISTS "tenant_isolation"` followed by a CREATE. This file
-- reverses the CREATE exactly, and it does NOT recreate `tenant_isolation`,
-- because no migration in this chain ever created it: grep the tree and 1082's
-- DROP is the only mention of that policy on this table. It existed only on
-- databases a catalog sweep had reached out of band, and the text it carried
-- there was never recorded, so restoring it would mean inventing DDL rather
-- than reversing any. Same class of gap the 0912 and 0911 rollbacks record:
-- prior state is restored where it was captured and the gap is named where it
-- was not.
--
-- SAFE TO LEAVE POLICY-LESS, and this is checked rather than assumed.
-- `organization_placement` has row security DISABLED (pg_class.relrowsecurity
-- is false on a chain-built database), so a table with no policy is not a table
-- that denies everything — the policy is inert either way. The guard below
-- refuses the rollback if that has changed, because dropping the only policy on
-- an RLS-enabled table locks every non-owner role out of it, which is a far
-- worse outcome than the 42501 that 1082 fixed.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$
DECLARE
  rls_on boolean;
  other_policies bigint;
BEGIN
  SELECT c.relrowsecurity INTO rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'organization_placement';

  IF NOT FOUND THEN
    RAISE NOTICE 'Rollback 1082: organization_placement does not exist; nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO other_policies
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'organization_placement'
     AND p.polname <> 'control_plane_access';

  IF rls_on AND other_policies = 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 1082: row security is ENABLED on organization_placement and '
      'control_plane_access is its only policy. Dropping it would deny every row to every '
      'non-owner role, taking placement resolution down harder than the defect 1082 fixed. '
      'Install the policy this database is meant to carry first, then re-run this rollback.';
  END IF;

  DROP POLICY IF EXISTS "control_plane_access" ON "organization_placement";
END
$rollback$;
