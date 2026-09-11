-- Reverses 0912. Removes the `feedbucket` row from `modules_catalog`.
--
-- REFUSES RATHER THAN CASCADES, and this is not hypothetical: running it
-- against the shared branch raises 23503 from
-- `org_modules_module_key_modules_catalog_module_key_fk` — an organisation has
-- feedbucket enabled. `org_modules.module_key` and `roles.module_key` are both
-- foreign keys onto this table, so a bare DELETE fails with a raw constraint
-- error that reads like a bug. It is not a bug, it is the correct answer: a
-- module tenants are using must not be deleted out from under them, and a
-- rollback that cascaded would take their entitlements and their seeded
-- FEEDBUCKET_MODULE_ADMIN roles with it.
--
-- So the refusal is made explicit and the raw FK error is pre-empted. If
-- nothing references the row it is deleted; if something does, this raises with
-- the count and the reason, which is what an operator needs at 3am.
--
-- ONE ASYMMETRY, stated because it cannot be fixed here. 0912 is
-- `INSERT ... ON CONFLICT (module_key) DO UPDATE SET is_core = false,
-- is_paid_only = false`. Where the row did not exist the INSERT branch runs and
-- this DELETE is its exact inverse. Where a row DID pre-exist with different
-- flags, 0912 overwrote them, their prior values were never recorded, and no
-- rollback can restore them — this would delete a row 0912 only edited. Same
-- class of gap the 0911 rollback records about its grants: prior state is
-- restored where it was captured and the gap is named where it was not.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $rollback$
DECLARE
  enabled_orgs bigint;
  seeded_roles bigint;
BEGIN
  SELECT count(*) INTO enabled_orgs FROM org_modules WHERE module_key = 'feedbucket';
  SELECT count(*) INTO seeded_roles FROM roles WHERE module_key = 'feedbucket';

  IF enabled_orgs > 0 OR seeded_roles > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back 0912: feedbucket is in use — % org_modules row(s) and % role(s) reference it. '
      'Removing the catalogue row would strip those entitlements and roles. '
      'Disable the module for those organisations first if this rollback is really intended.',
      enabled_orgs, seeded_roles;
  END IF;

  DELETE FROM modules_catalog WHERE module_key = 'feedbucket';
END
$rollback$;
