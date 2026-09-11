-- Reverses 1005 by removing the feedbucket catalog row. Reinstates the P0:
-- with the row gone, seedSystemRolesForOrg raises 23503 on fk_roles_module and
-- organisation creation rolls back. Provided so the chain is reversible.
--
-- Guarded: refuses to run while a role still points at it, so the rollback
-- cannot leave a dangling module_key behind.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE module_key = 'feedbucket') THEN
    RAISE EXCEPTION 'cannot remove the feedbucket catalog row while roles reference it';
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM "modules_catalog" WHERE "module_key" = 'feedbucket';
